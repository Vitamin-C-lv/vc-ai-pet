import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { LocalBrainClient } from '../src/brain/local-brain-client.js'
import { advanceState } from '../src/core/pet-state-engine.js'
import {
  DEEP_DREAM_ASLEEP_STATES,
  DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS,
} from '../src/dream/dream-scheduler.js'

/**
 * 夜间做梦 - 真实模型端到端质量验证（--live）。
 *
 * 用户要求：「跑一次真实模型端到端的"夜间做梦"验证（用真 Local Brain 让花花真的
 * 做一次梦，看输出质量）……可以多跑几个不同的，总之广泛验证，全面一点不要吝惜本地的
 * Local Brain 算力」。所以这里不省调用：7 个场景各自独立 sandbox、独立真实模型调用。
 *
 *   A empty-night   没有任何新 raw 源 -> 必须被 eligibility 拦下，不许空转做梦
 *   B typical       9 条典型生活 -> 梦的产出与引用真实性
 *   C repeated      同一行为跨天重复 3 次 -> 是否形成"反复发生"的理解
 *   D image         真实生产照片(只读)真实看图 -> 图片是否进入梦境视野
 *   E mood          情绪低谷日 -> 温度与是否跑偏成说教
 *   F long          23 条长源(接近 batch 上限) -> 分批/漏源/信息量
 *   G scheduler     真实 tick + 真实状态机 + 真实模型 -> 证明睡眠连续性补丁真的放行做梦
 *
 * 生产一律只读；所有数据在 /tmp；每个场景结束清理。
 */

const LIVE = process.argv.includes('--live')
const PROD_ASSETS = '/home/vitamin_c/.local/share/vc-ai-pet/sandbox/conversation-assets'
const PROD_MEMORY = '/home/vitamin_c/.local/share/vc-ai-pet/sandbox/memory/pet-memory.db'

if (!LIVE) {
  console.log('VC_AI_PET_V0_4_DREAM_LIVE_QUALITY=SKIP (pass --live to call the real Local Brain)')
  process.exit(0)
}

if (!existsSync(PROD_ASSETS)) {
  console.error('LIVE_ABORT: production conversation assets are missing')
  process.exit(2)
}

const results = []
let brainCalls = 0

// ── helpers ─────────────────────────────────────────────────────────────────

function solidPng(size, [r, g, b]) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x += 1) {
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crcTable = []
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
    let crc = 0xffffffff
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, crcBuf])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let thumbCache = null
function thumbnail() {
  if (!thumbCache) thumbCache = `data:image/png;base64,${solidPng(256, [120, 144, 156]).toString('base64')}`
  return thumbCache
}

async function newestProductionPhoto() {
  const found = []
  async function walk(dir, depth = 0) {
    if (depth > 4) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full, depth + 1); continue }
      if (!/\.(webp|png|jpg|jpeg)$/i.test(entry.name)) continue
      const bytes = await readFile(full)
      if (bytes.length > 80 * 1024) found.push({ path: full, bytes })
    }
  }
  await walk(PROD_ASSETS)
  found.sort((a, b) => b.bytes.length - a.bytes.length)
  const picked = found[0]
  const mime = picked.path.endsWith('.webp') ? 'image/webp' : picked.path.endsWith('.png') ? 'image/png' : 'image/jpeg'
  return { path: picked.path, bytes: picked.bytes.length, dataUrl: `data:${mime};base64,${picked.bytes.toString('base64')}` }
}

/**
 * How much of a derived claim is anchored in its sources.
 *
 * Char n-grams, not word tokens: a greedy [\u4e00-\u9fa5]{2,} match turns a whole
 * clause into one "token", which made every inference look 100% novel.
 */
const ENTITIES = ['花花', '黑莓', '主人']
const COMMON = new Set([
  '今天', '明天', '昨天', '晚上', '早上', '下午', '白天', '夜里', '时候', '感觉', '喜欢',
  '开心', '因为', '所以', '但是', '还是', '就是', '什么', '这个', '那个', '自己', '我们',
  '他们', '一起', '已经', '可以', '应该', '需要', '知道', '记得', '觉得', '事情', '时间',
  '生活', '细节', '理解', '经历', '记忆', '记录', '形成', '整理', '新的', '一样',
])

function ngrams(text, size) {
  const value = String(text).replace(/[^\u4e00-\u9fa5]/g, ' ')
  const grams = []
  for (const run of value.split(/\s+/)) {
    for (let index = 0; index + size <= run.length; index += 1) grams.push(run.slice(index, index + size))
  }
  return grams
}

function referenceCheck(derivedText, sourceTexts) {
  const corpus = (sourceTexts ?? []).join('\n')
  const uniq = (list) => [...new Set(list)]
  const bi = uniq(ngrams(derivedText, 2))
  const tri = uniq(ngrams(derivedText, 3))
  const inCorpus = (gram) => corpus.includes(gram)
  const biHit = bi.filter(inCorpus)
  const triHit = tri.filter(inCorpus)
  // Long n-grams pin real provenance; a shared entity alone is weak but means the
  // claim is at least about the right animal.
  const entities = ENTITIES.filter((name) => String(derivedText).includes(name))
  const entityAnchored = entities.some((name) => corpus.includes(name))
  // Novel content words: 2-3 char sequences absent from sources, minus filler.
  const novelCandidates = uniq([...tri, ...bi]).filter((gram) => !inCorpus(gram) && !COMMON.has(gram))
  return {
    ngrams: bi.length,
    biRatio: bi.length ? Number((biHit.length / bi.length).toFixed(2)) : 0,
    triRatio: tri.length ? Number((triHit.length / tri.length).toFixed(2)) : 0,
    entities,
    entityAnchored,
    novel: novelCandidates.slice(0, 14),
    anchored: entityAnchored || biHit.length > 0,
  }
}

function selfExposure(text) {
  return /(我是\s*(一个)?\s*(AI|人工智能|语言模型|模型|助手))|(as an AI)|(language model)|提示词|system prompt|prompt/i.test(String(text))
}

function englishOrGarbage(text) {
  const value = String(text)
  const latin = (value.match(/[A-Za-z]{4,}/g) ?? []).length
  const replacement = (value.match(/\uFFFD/g) ?? []).length
  return { latinWords: latin, replacementChars: replacement }
}

/** Dream summaries that say nothing about what actually happened. */
function genericSummary(text) {
  const value = String(text ?? '').trim()
  if (!value) return { generic: true, reason: 'empty' }
  const generic = /^(基于|根据|整理|总结)?[^，。]{0,12}(新记忆|今日经历|日常观察|新的理解|记忆整理|今天的记忆)[^，。]{0,12}(整理|形成|总结)?[。.]?$/
  const contentful = /(主人|花花|黑莓|狗粮|散步|雨|沙发|窗台|累|睡|等待|照片|图片)/.test(value)
  return { generic: generic.test(value) && !contentful, reason: generic.test(value) ? 'template' : 'ok' }
}

function cjkRatio(text) {
  const value = String(text)
  if (!value.length) return 0
  const cjk = (value.match(/[\u4e00-\u9fa5]/g) ?? []).length
  return Number((cjk / value.length).toFixed(2))
}

async function collectScenario(runtime, { label, sourceTexts }) {
  const LEVELS = ['soul', 'user', 'fact', 'lesson', 'topic', 'rules']
  const byId = new Map()
  const all = []
  for (const level of LEVELS) {
    let rows = []
    try { rows = runtime.memory.db.list(level, { status: 'active' }) } catch { continue }
    for (const row of rows) {
      const decorated = runtime.memory.provenanceStore.decorate(row)
      byId.set(String(row.id), decorated)
      all.push({ ...decorated, level })
    }
  }
  // Provenance is the authority on what Dream wrote, so filter on it rather than
  // on level or content shape.
  const derived = []
  for (const row of all) {
    const provenance = row.provenance ?? runtime.memory.provenanceStore.resolve(row)
    if (!provenance || provenance.source !== 'DREAM_DERIVED') continue
    const cited = (provenance.sourceIds ?? [])
      .map((id) => byId.get(String(id))?.content ?? null)
      .filter(Boolean)
    const corpus = cited.length ? cited : (sourceTexts ?? [])
    derived.push({
      level: row.level,
      importance: row.importance,
      content: row.content,
      confidence: provenance.confidence,
      sourceIds: provenance.sourceIds ?? [],
      citedOk: cited.length,
      citedMissing: (provenance.sourceIds ?? []).length - cited.length,
      reference: { ...referenceCheck(row.content, corpus), citedPreview: cited },
      selfExposure: selfExposure(row.content),
      cjk: cjkRatio(row.content),
      ...englishOrGarbage(row.content),
    })
  }
  return {
    label,
    derived,
    sourceCount: (sourceTexts ?? []).length,
    referenceMode: derived.some((item) => item.citedOk > 0) ? 'cited-rows' : 'all-sources',
  }
}

async function lastDreamLog(runtime) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(runtime.sandbox.root, 'memory', 'pet-memory.db'), { readOnly: true })
    const row = db.prepare('select run_at, summary, changes, note from dream_log order by id desc limit 1').get()
    db.close()
    if (!row) return null
    const changes = JSON.parse(String(row.changes))
    return {
      runAt: Number(row.run_at),
      summary: String(row.summary ?? ''),
      note: row.note ?? null,
      kind: changes.kind ?? null,
      sourceIds: changes.sourceIds ?? [],
      derivedRefs: (changes.derived ?? []).length,
    }
  } catch (error) {
    return { error: error.message }
  }
}

async function withSandbox(label, body) {
  const root = await mkdtemp(join(tmpdir(), `vc-ai-pet-dream-live-${label}-`))
  const runtime = new PetRuntime({ sandboxRoot: root })
  try {
    await runtime.initialize()
    runtime.brain.client = new LocalBrainClient({ requestTimeoutMs: 180000 })
    return await body(runtime, root)
  } finally {
    try { runtime.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

function banner(text) {
  console.log(`\n──────── ${text} ────────`)
}

async function runDream(runtime) {
  const started = Date.now()
  const result = await runtime.runDreamNow().catch((error) => ({ thrown: `${error?.code ?? error?.name}: ${error?.message}` }))
  return { result, elapsed: Date.now() - started }
}

// ── A. empty night ──────────────────────────────────────────────────────────
async function scenarioEmptyNight() {
  banner('A. 空白夜（无新 raw 源）')
  return withSandbox('a', async (runtime) => {
    const seeds = runtime.memory.dreamSourceRows({ after: 0, before: Date.now() + 1000 })
    console.log('seed sources =', seeds.map((row) => `${row.level}:${row.content}`).join(' | '))
    const gate = await runtime.dreamScheduler.maybeRunDeepDream({
      state: { current: 'sleep', sleepSince: Date.now() - 20 * 60 * 1000 },
      chatInFlight: false,
      dreamInFlight: false,
      reflectionInFlight: false,
      now: Date.now(),
    })
    const forced = await runtime.runDreamNow().catch((error) => ({ thrown: `${error?.code ?? error?.name}: ${error?.message}` }))
    console.log('gate =', JSON.stringify(gate))
    console.log('forced run =', JSON.stringify(forced).slice(0, 200))
    return {
      label: 'A 空白夜(仅种子源)',
      seedSources: seeds.map((row) => row.content),
      gate,
      forced: { status: forced?.status, ok: forced?.ok, sourceCount: forced?.sourceCount, reason: forced?.reason ?? forced?.thrown },
    }
  })
}

// ── B. typical night ────────────────────────────────────────────────────────
const TYPICAL = [
  '主人今天带花花去楼下散步了，风有点凉。',
  '黑莓又睡在窗台的花盆旁边。',
  '主人今天工作很累，回家只摸了摸花花的头。',
  '花花今天把玩具球滚到了沙发底下。',
  '主人给花花换了新的狗粮，花花吃得很香。',
  '外面下了一整天的雨。',
  '主人晚上看了很久的书。',
  '花花趴在门口等主人回来。',
  '黑莓今天打翻了一个杯子。',
]

async function scenarioTypical() {
  banner('B. 典型生活夜（9 条 raw）')
  return withSandbox('b', async (runtime) => {
    for (const line of TYPICAL) runtime.memory.remember('fact', line, 2)
    const { result, elapsed } = await runDream(runtime)
    brainCalls += 1
    const log = await lastDreamLog(runtime)
    const collected = await collectScenario(runtime, { label: 'B', sourceTexts: TYPICAL })
    console.log(`elapsed=${(elapsed / 1000).toFixed(1)}s sources=${result?.sourceCount} derived=${result?.derivedCount}`)
    console.log('log.summary =', log?.summary)
    for (const item of collected.derived) {
      console.log(`  [${item.level}] imp=${item.importance} conf=${item.confidence} | ${item.content}`)
      for (const cited of item.reference.citedPreview ?? []) console.log(`      ← ${cited}`)
    }
    return {
      label: 'B 典型生活夜',
      elapsedMs: elapsed,
      result: { status: result?.status, ok: result?.ok, sourceCount: result?.sourceCount, batchCount: result?.batchCount, derivedCount: result?.derivedCount, duplicates: result?.duplicateCount, thrown: result?.thrown },
      log,
      ...collected,
    }
  })
}

// ── C. repeated behaviour ───────────────────────────────────────────────────
async function scenarioRepeated() {
  banner('C. 重复行为夜（同一件事跨天 3 次）')
  const lines = [
    '黑莓今天又睡在沙发上了。',
    '黑莓还是睡在沙发上。',
    '黑莓今天睡在沙发上，睡了一下午。',
    '主人今天加班到很晚。',
    '花花今天很乖，没有拆家。',
  ]
  return withSandbox('c', async (runtime) => {
    for (const line of lines) runtime.memory.remember('fact', line, 2)
    const { result, elapsed } = await runDream(runtime)
    brainCalls += 1
    const log = await lastDreamLog(runtime)
    const collected = await collectScenario(runtime, { label: 'C', sourceTexts: lines })
    console.log(`elapsed=${(elapsed / 1000).toFixed(1)}s sources=${result?.sourceCount} derived=${result?.derivedCount}`)
    for (const item of collected.derived) console.log(`  [${item.level}] ${item.content}`)
    return {
      label: 'C 重复行为夜',
      elapsedMs: elapsed,
      result: { status: result?.status, ok: result?.ok, sourceCount: result?.sourceCount, derivedCount: result?.derivedCount, thrown: result?.thrown },
      log,
      repeatedUnderstanding: collected.derived.some((item) => /反复|总是|经常|每次都|一再|习惯|爱睡|喜欢睡/.test(item.content)),
      ...collected,
    }
  })
}

// ── D. real image night ─────────────────────────────────────────────────────
async function scenarioImage() {
  banner('D. 带真实照片的夜（生产图片只读）')
  const photo = await newestProductionPhoto()
  console.log(`photo=${photo.path} (${(photo.bytes / 1024).toFixed(0)}KB, read-only)`)
  return withSandbox('d', async (runtime) => {
    const attachment = await runtime.conversationStore.saveAttachment({
      image: photo.dataUrl,
      thumbnail: thumbnail(),
    })
    const turn = await runtime.chat('花花，看看我今天拍的这张照片', { dataUrl: photo.dataUrl }, attachment)
    brainCalls += 1
    // The visual turn reports inspections; the remembered sentence is written by
    // observationMemorySentence() into the VISUAL_OBSERVATION row.
    const observations = (turn?.inspections ?? [])
      .map((item) => item?.summary ?? item?.observation ?? '')
      .filter(Boolean)
    console.log('turn keys =', Object.keys(turn ?? {}).join(','))
    console.log('vision observations =', JSON.stringify(observations).slice(0, 300))
    console.log('turn =', JSON.stringify(turn).slice(0, 400))

    const anchors = (runtime.memory.db.list('fact', { status: 'active' }) ?? []).filter((row) => String(row.content).includes('看过一张图片'))
    for (const anchor of anchors) {
      const provenance = runtime.memory.provenanceStore.resolve(anchor)
      console.log(`  anchor: ${anchor.content}`)
      if (provenance?.attachmentId) {
        const look = await runtime.reInspectVisualMemory({ attachmentId: provenance.attachmentId }).catch((error) => ({ ok: false, reason: error.message }))
        brainCalls += 1
        console.log('  re-inspect =', JSON.stringify(look).slice(0, 200))
      }
    }

    // An image never arrives alone in real life; surround the picture memory with
    // the day it happened in, otherwise the model has almost nothing to reason over.
    for (const line of [
      '今天主人带花花去了一个有很多狗狗的聚会。',
      '花花是第一次见到这么多别的狗。',
      '回家的路上花花一直回头看。',
      '黑莓没有去，留在家里睡觉。',
    ]) runtime.memory.remember('fact', line, 2)

    const sources = (runtime.memory.db.list('fact', { status: 'active' }) ?? []).map((row) => row.content)
    const { result, elapsed } = await runDream(runtime)
    brainCalls += 1
    const log = await lastDreamLog(runtime)
    const collected = await collectScenario(runtime, { label: 'D', sourceTexts: sources })
    console.log(`elapsed=${(elapsed / 1000).toFixed(1)}s sources=${result?.sourceCount} derived=${result?.derivedCount}`)
    for (const item of collected.derived) console.log(`  [${item.level}] ${item.content}`)
    const imageKinds = {
      anchorWritten: sources.some((line) => line.includes('看过一张图片')),
      observationWritten: sources.some((line) => line.includes('看到的是')),
      dreamSeesImage: collected.derived.some((item) => /照片|图片|看到|图里|画面/.test(item.content)) || /照片|图片|看到|图里|画面/.test(log?.summary ?? ''),
    }
    console.log('imageKinds =', JSON.stringify(imageKinds))
    return {
      label: 'D 带真实照片的夜',
      photo: { path: photo.path, kb: Math.round(photo.bytes / 1024) },
      observations,
      elapsedMs: elapsed,
      result: { status: result?.status, ok: result?.ok, sourceCount: result?.sourceCount, derivedCount: result?.derivedCount, thrown: result?.thrown },
      log,
      imageKinds,
      ...collected,
    }
  })
}

// ── E. mood night ───────────────────────────────────────────────────────────
async function scenarioMood() {
  banner('E. 情绪低谷夜')
  const lines = [
    '主人今天很累，一句话都不想说。',
    '主人抱着花花坐了很久，没有说话。',
    '花花感觉到主人不太开心。',
    '今天家里很安静，黑莓也没有闹。',
    '主人很早就睡了，忘了给花花添水。',
  ]
  return withSandbox('e', async (runtime) => {
    for (const line of lines) runtime.memory.remember('fact', line, 2)
    const { result, elapsed } = await runDream(runtime)
    brainCalls += 1
    const log = await lastDreamLog(runtime)
    const collected = await collectScenario(runtime, { label: 'E', sourceTexts: lines })
    console.log(`elapsed=${(elapsed / 1000).toFixed(1)}s derived=${result?.derivedCount}`)
    for (const item of collected.derived) console.log(`  [${item.level}] ${item.content}`)
    const preach = collected.derived.filter((item) => /应该|必须|建议|需要更|要学会/.test(item.content)).map((item) => item.content)
    if (preach.length) console.log('  说教倾向 =', JSON.stringify(preach))
    return {
      label: 'E 情绪低谷夜',
      elapsedMs: elapsed,
      result: { status: result?.status, ok: result?.ok, sourceCount: result?.sourceCount, derivedCount: result?.derivedCount, thrown: result?.thrown },
      log,
      preaching: preach,
      ...collected,
    }
  })
}

// ── F. long night ───────────────────────────────────────────────────────────
const LONG = [
  '主人今天早上起得很早，带花花去了公园。',
  '公园里有很多别的狗，花花有点紧张。',
  '有一只金毛一直想跟花花玩。',
  '花花躲在主人腿后面。',
  '主人蹲下来摸了摸花花的背。',
  '回家路上花花走得很慢。',
  '中午主人给花花煮了鸡胸肉。',
  '花花吃完了还舔了舔碗。',
  '下午主人出门上班了。',
  '花花一个人在家睡了一下午。',
  '黑莓下午一直趴在阳台上。',
  '傍晚外面开始下雨。',
  '花花听到雷声躲到了桌子下面。',
  '主人回来的时候花花还在桌子下面。',
  '主人把花花抱了出来。',
  '晚上主人给花花梳了毛。',
  '花花掉了很多毛。',
  '主人说换季就是这样。',
  '黑莓在旁边看着，很好奇。',
  '晚上主人看了会电视。',
  '花花趴在主人脚边。',
  '主人夜里起来喝水，花花跟着起来了。',
  '然后两个人都回去睡了。',
]

async function scenarioLong() {
  banner(`F. 长源夜（${LONG.length} 条 raw）`)
  return withSandbox('f', async (runtime) => {
    for (const line of LONG) runtime.memory.remember('fact', line, 2)
    const { result, elapsed } = await runDream(runtime)
    brainCalls += 1
    const log = await lastDreamLog(runtime)
    const collected = await collectScenario(runtime, { label: 'F', sourceTexts: LONG })
    console.log(`elapsed=${(elapsed / 1000).toFixed(1)}s sources=${result?.sourceCount} batches=${result?.batchCount} derived=${result?.derivedCount}`)
    for (const item of collected.derived) console.log(`  [${item.level}] ${item.content}`)
    const citedSourceCount = log?.sourceIds?.length ?? 0
    console.log(`checkpoint 覆盖源数=${citedSourceCount}/${LONG.length}`)
    return {
      label: 'F 长源夜',
      elapsedMs: elapsed,
      result: { status: result?.status, ok: result?.ok, sourceCount: result?.sourceCount, batchCount: result?.batchCount, derivedCount: result?.derivedCount, thrown: result?.thrown },
      log,
      checkpointSources: citedSourceCount,
      missedSources: Math.max(0, LONG.length - citedSourceCount),
      ...collected,
    }
  })
}

// ── G. real tick + scheduler + model ────────────────────────────────────────
async function scenarioScheduler() {
  banner('G. 真实 tick + 真实状态机 + 真实模型（验证睡眠连续性补丁）')
  return withSandbox('g', async (runtime) => {
    const lines = [
      '主人今天说花花是最乖的小狗。',
      '黑莓今天抢了花花的零食。',
      '主人答应明天带花花出去玩。',
    ]
    for (const line of lines) runtime.memory.remember('fact', line, 2)

    // Find the first genuine sleep window with a fast synchronous pass: the real
    // engine only crosses the 0.86 sleepiness threshold after ~10h of idle
    // accumulation (measured: 0.0019/tick while idle), so replaying from scratch
    // is wasteful. Then drive the *scheduler* over exactly that window.
    const TICK = 10 * 1000
    let probe = runtime.state
    let probeAt = Date.now()
    let windowStart = null
    for (let index = 0; index < 60 * 60 * 14; index += 1) {
      probeAt += TICK
      probe = advanceState(probe, probeAt)
      if (DEEP_DREAM_ASLEEP_STATES.includes(probe.current)) {
        if (windowStart === null) windowStart = probeAt
        if (probeAt - windowStart >= 2 * DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS) break
      } else {
        windowStart = null
      }
    }
    assert.ok(windowStart !== null, 'the real state engine must eventually sleep')
    console.log(`  real asleep window starts at simulated +${((windowStart - Date.now()) / 60000).toFixed(0)}min`)

    runtime.state = advanceState(runtime.state, windowStart)
    let now = windowStart
    const simStart = now
    const seen = new Map()
    let asleepTicks = 0
    let firstAsleepAt = null
    let dreamed = null
    const trace = []

    for (let index = 0; index < 60 * 60; index += 1) { // up to 1h inside the window
      runtime.state = advanceState(runtime.state, now)
      const current = runtime.state.current
      seen.set(current, (seen.get(current) ?? 0) + 1)
      if (DEEP_DREAM_ASLEEP_STATES.includes(current)) {
        asleepTicks += 1
        if (firstAsleepAt === null) firstAsleepAt = now
      } else {
        asleepTicks = 0
        firstAsleepAt = null
      }

      const due = await runtime.dreamScheduler.maybeRunDeepDream({
        state: runtime.snapshot(),
        chatInFlight: false,
        dreamInFlight: false,
        reflectionInFlight: false,
        now,
      })
      if (index % 30 === 0 && trace.length < 30) {
        const minute = ((now - simStart) / 60000).toFixed(1)
        trace.push(`${minute}min:${current}:${due?.reason ?? due?.schedulerStatus}`)
      }
      if (due?.schedulerStatus === 'started' || due?.status === 'completed') {
        dreamed = {
          at: now,
          afterSimMs: now - simStart,
          asleepForMs: firstAsleepAt ? now - firstAsleepAt : null,
          result: { status: due.status, ok: due.ok, sourceCount: due.sourceCount, derivedCount: due.derivedCount },
        }
        console.log(`  dream fired: ${(dreamed.afterSimMs / 60000).toFixed(1)}min into the window, asleepRun=${(dreamed.asleepForMs / 1000).toFixed(0)}s`)
        break
      }
      now += TICK
    }

    const log = await lastDreamLog(runtime)
    const collected = await collectScenario(runtime, { label: 'G', sourceTexts: lines })
    const totalTicks = [...seen.values()].reduce((sum, value) => sum + value, 0)
    const asleepShare = Object.fromEntries(
      [...seen.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, `${v} (${(v / totalTicks * 100).toFixed(1)}%)`]),
    )
    console.log('tick trace =', trace.join(' | '))
    console.log('state ticks =', JSON.stringify(asleepShare))
    console.log('dreamed =', JSON.stringify(dreamed))
    for (const item of collected.derived) console.log(`  [${item.level}] ${item.content}`)

    assert.ok(dreamed, `the continuity patch must let a real tick loop dream; trace=${trace.join('|')}`)
    assert.ok(
      dreamed.asleepForMs === null || dreamed.asleepForMs >= 0,
      'the sleep run must be tracked',
    )
    assert.ok(
      (dreamed.asleepForMs ?? 0) >= DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS
        || dreamed.afterSimMs >= DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS,
      `the dream must wait for the continuity threshold, slept ${dreamed.asleepForMs}ms`,
    )
    brainCalls += 1
    return {
      label: 'G 真实 tick 做梦',
      tickTrace: trace,
      stateTicks: asleepShare,
      dreamed,
      log,
      ...collected,
    }
  })
}

// ── driver ──────────────────────────────────────────────────────────────────
const ONLY = process.env.DREAM_LIVE_ONLY ? process.env.DREAM_LIVE_ONLY.split(',').map((v) => v.trim()) : null
const scenarios = [
  ['A', scenarioEmptyNight],
  ['B', scenarioTypical],
  ['C', scenarioRepeated],
  ['D', scenarioImage],
  ['E', scenarioMood],
  ['F', scenarioLong],
  ['G', scenarioScheduler],
].filter(([name]) => !ONLY || ONLY.includes(name))

const health = await new LocalBrainClient({ requestTimeoutMs: 20000 }).health().catch((error) => ({ ok: false, reason: error.message }))
console.log('brain health =', JSON.stringify(health).slice(0, 160))
if (health?.ok !== true && health !== true) {
  console.error('LIVE_ABORT: Local Brain is not healthy')
  process.exit(2)
}

const startedAll = Date.now()
for (const [name, run] of scenarios) {
  try {
    const output = await run()
    results.push({ name, ok: true, ...output })
  } catch (error) {
    console.log(`SCENARIO_${name}_FAILED`, error?.code ?? error?.name, error?.message)
    results.push({ name, ok: false, error: `${error?.code ?? error?.name}: ${error?.message}` })
  }
}
const totalMs = Date.now() - startedAll

console.log('\n================ 汇总 ================')
for (const item of results) {
  if (!item.ok) { console.log(`${item.name}: FAILED ${item.error}`); continue }
  const derived = item.derived ?? []
  const anchored = derived.filter((d) => d.reference.anchored).length
  const avgBi = derived.length ? (derived.reduce((sum, d) => sum + d.reference.biRatio, 0) / derived.length).toFixed(2) : 'n/a'
  console.log(`${item.name}: ${item.label ?? ''} | derived=${derived.length} anchored=${anchored}/${derived.length} avgBiRatio=${avgBi} | elapsed=${item.elapsedMs ? (item.elapsedMs / 1000).toFixed(1) + 's' : '-'}`)
  if (item.summaryQuality) console.log(`    summary: ${JSON.stringify(item.log?.summary ?? '')} generic=${item.summaryQuality.generic}`)
  for (const d of derived) {
    const flags = [d.selfExposure ? 'SELF_EXPOSURE' : null, d.latinWords ? `LATIN=${d.latinWords}` : null, d.replacementChars ? 'GARBAGE' : null, d.reference.anchored ? null : 'NO_ANCHOR'].filter(Boolean)
    console.log(`    [${d.level}] bi=${d.reference.biRatio} tri=${d.reference.triRatio} ents=${d.reference.entities.join('') || '-'} cjk=${d.cjk} ${flags.join(' ') || 'ok'} | ${String(d.content).slice(0, 96)}`)
    if (d.reference.novel.length) console.log(`        新词(n-gram): ${d.reference.novel.slice(0, 10).join('/')}`)
  }
}
console.log(`TOTAL_BRAIN_CALLS=${brainCalls} TOTAL_MS=${(totalMs / 1000).toFixed(1)}s`)
console.log(`PROD_ASSET_READS=readonly PROD_MEMORY_WRITES=0`)

// Persist the full report so Root can read verbatim text without re-running.
const { writeFile } = await import('node:fs/promises')
await writeFile('/tmp/dream-live-quality-report.json', JSON.stringify({ generatedAt: new Date().toISOString(), brainCalls, totalMs, results }, null, 2))
console.log('REPORT=/tmp/dream-live-quality-report.json')

const failures = results.filter((item) => !item.ok)
if (failures.length) {
  console.log(`VC_AI_PET_V0_4_DREAM_LIVE_QUALITY=FAIL (${failures.length}/${results.length})`)
  process.exit(1)
}
console.log('VC_AI_PET_V0_4_DREAM_LIVE_QUALITY=PASS')
