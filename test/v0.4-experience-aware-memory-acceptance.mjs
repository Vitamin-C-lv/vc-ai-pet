import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { EXPERIENCE_BUFFER_DB_FILENAME } from '../src/experience/experience-buffer.js'

/**
 * Experience-aware Memory Pipeline — end to end acceptance.
 *
 * These five cases are the ones the owner named explicitly. They run a real
 * PetRuntime against a temporary sandbox with a stub local brain, so the memory
 * pipeline (gate, queue, experience buffer, reflection) is exercised for real
 * while no model is called and no production data is touched.
 *
 * The stub brain is honest about what it returns: for the explicit-memory case
 * it deliberately answers `remember:false`, which is exactly the situation that
 * used to lose the owner's request.
 */

const CHITCHAT = [
  '今天天气不错呀',
  '花花你在干嘛呢',
  '摸摸头',
  '外面好像下雨了',
  '花花喜欢吃什么',
  '我今天有点累',
  '晚上吃点什么呢',
  '花花陪我待一会儿',
  '哈哈哈你好可爱',
  '你在家乖不乖',
  '今天路上有点堵',
  '花花想出去玩吗',
  '我一会儿要去洗澡',
  '你困不困呀',
  '花花会唱歌吗',
  '帮我把窗户关上吧',
  '今天过得真快',
  '明天还要早起',
  '有点想睡觉了',
  '晚安花花',
]

function stubBrain({ remember = false } = {}) {
  const calls = []
  return {
    calls,
    async reply(request) {
      const userText = String(request?.userText ?? '')
      calls.push({ userText, recentMessages: request?.recentMessages?.length ?? 0 })
      return {
        ok: true,
        text: `花花听到啦：${userText.slice(0, 12)}`,
        replyMessages: [`花花听到啦：${userText.slice(0, 12)}`],
        // A conservative model: it never volunteers a memory candidate.
        memoryCandidate: null,
        rawMemoryCandidate: {
          remember,
          level: 'fact',
          content: '',
          importance: 1,
          keywords: [],
          confidence: 0,
          evidence: '',
        },
        beliefCandidates: [],
        memoryDecision: remember ? 'accepted' : 'model-skip',
        structured: true,
      }
    },
    async reflectionCompletion() {
      return {
        ok: true,
        rawText: JSON.stringify({
          summary: '花花整理了最近和主人一起经历的事。',
          memories: [],
        }),
      }
    },
  }
}

function openBufferDb(root) {
  return new DatabaseSync(join(root, EXPERIENCE_BUFFER_DB_FILENAME), { readOnly: true })
}

async function withRuntime(run, { remember = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-acceptance-'))
  const runtime = new PetRuntime({ sandboxRoot: root })
  try {
    await runtime.initialize()
    runtime.brain = stubBrain({ remember })
    await run({ runtime, root })
  } finally {
    try { runtime.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

/** Case 1 — an explicit request must survive twenty unrelated turns. */
async function caseExplicitMemorySurvivesChitchat() {
  await withRuntime(async ({ runtime }) => {
    const first = await runtime.chat('记住我们家的猫叫黑莓')
    assert.equal(first.ok, true, 'the owning turn must succeed')
    assert.equal(first.memoryWrite, 'written', `explicit request must be written, got ${first.memoryWrite}`)
    assert.equal(first.memoryPriority, 'HIGH', 'an explicit request must carry HIGH priority metadata')

    // The owner usually restates the fact right after instructing the pet. That
    // sentence carries no keyword, and it used to be dropped — the pet forgot
    // the cat it had just been told about. Either it is written, or the gate
    // recognises it as the same fact and reports `duplicate`; both mean the
    // instruction was honoured. `skipped` is the failure.
    const restated = await runtime.chat('我们家的猫叫黑莓')
    assert.equal(restated.ok, true)
    assert.notEqual(
      restated.memoryWrite,
      'skipped',
      'a restatement under a live instruction must not be dropped',
    )

    for (const line of CHITCHAT) {
      const turn = await runtime.chat(line)
      assert.equal(turn.ok, true, `chitchat turn failed: ${line}`)
    }

    const recalled = runtime.recall('猫叫什么', 5)
    const contents = recalled.map((row) => String(row.content))
    assert.ok(
      contents.some((content) => content.includes('黑莓')),
      `cat name must be recallable after 20 turns, got ${JSON.stringify(contents)}`,
    )
    console.log('CASE_1_EXPLICIT_MEMORY_SURVIVES_20_TURNS=PASS')
  })
}

/** Case 2 — three repeated mentions must leave repeated-behaviour evidence. */
async function caseRepeatedBehaviourBecomesCandidate() {
  await withRuntime(async ({ runtime, root }) => {
    for (const line of ['黑莓今天睡沙发', '黑莓又睡沙发了', '黑莓还是睡沙发']) {
      const turn = await runtime.chat(line)
      assert.equal(turn.ok, true)
    }

    const db = openBufferDb(root)
    try {
      const rows = db
        .prepare("SELECT content, source_type, importance_score FROM experience_events ORDER BY id")
        .all()
      const sofaRows = rows.filter((row) => String(row.content).includes('沙发'))
      assert.ok(sofaRows.length >= 3, `expected 3 sofa experiences, got ${sofaRows.length}`)
      assert.ok(
        sofaRows.some((row) => row.source_type === 'repeated_behavior'),
        `a repeat must be classified as repeated_behavior, got ${JSON.stringify(sofaRows.map((r) => r.source_type))}`,
      )
    } finally {
      db.close()
    }
    console.log('CASE_2_REPEATED_BEHAVIOUR_CANDIDATE=PASS')
  })
}

/** Case 3 — a literal explicit request must enter the HIGH priority queue. */
async function caseExplicitBirthdayEntersQueue() {
  await withRuntime(async ({ runtime }) => {
    const turn = await runtime.chat('记住黑莓生日是8月31日')
    assert.equal(turn.ok, true)
    assert.equal(turn.memoryWrite, 'written', `birthday must be written, got ${turn.memoryWrite}`)

    const queued = runtime.explicitMemoryQueue?.listPending?.() ?? []
    const all = runtime.explicitMemoryQueue?.snapshot?.() ?? queued
    assert.ok(all.length >= 1, 'the explicit request must be recorded in the queue')
    const entry = all[0]
    assert.equal(entry.priority, 'HIGH', `priority must be HIGH, got ${entry.priority}`)
    assert.equal(entry.source, 'USER_EXPLICIT', `source must be USER_EXPLICIT, got ${entry.source}`)
    assert.ok(
      entry.status === 'written' || entry.memoryId,
      `queued entry must resolve to a write, got ${entry.status}`,
    )

    const recalled = runtime.recall('黑莓生日', 5).map((row) => String(row.content))
    assert.ok(recalled.some((content) => content.includes('8月31日')), `birthday must be durable, got ${JSON.stringify(recalled)}`)
    console.log('CASE_3_EXPLICIT_QUEUE_HIGH_PRIORITY=PASS')
  })
}

/** Case 4 — reflection must consume the buffer and mark experiences processed. */
async function caseReflectionConsumesBuffer() {
  await withRuntime(async ({ runtime, root }) => {
    for (const line of ['黑莓今天睡沙发', '黑莓又睡沙发了', '黑莓还是睡沙发', '花花陪主人玩了一会儿']) {
      await runtime.chat(line)
    }

    const before = openBufferDb(root)
    let pendingBefore = 0
    try {
      pendingBefore = Number(before.prepare('SELECT COUNT(*) AS n FROM experience_events WHERE processed = 0').get().n)
    } finally {
      before.close()
    }
    assert.ok(pendingBefore >= 4, `expected pending experiences before reflection, got ${pendingBefore}`)

    const reflection = await runtime.runReflectionNow()
    assert.ok(reflection, 'reflection must return a result')

    const after = openBufferDb(root)
    try {
      const pending = Number(after.prepare('SELECT COUNT(*) AS n FROM experience_events WHERE processed = 0').get().n)
      const processed = Number(after.prepare('SELECT COUNT(*) AS n FROM experience_events WHERE processed = 1').get().n)
      assert.ok(processed >= 1, 'reflection output must include consumed experiences')
      assert.ok(pending < pendingBefore, `pending experiences must decrease (before=${pendingBefore} after=${pending})`)
    } finally {
      after.close()
    }
    console.log('CASE_4_REFLECTION_CONSUMES_BUFFER=PASS')
  })
}

/** Case 5 — the dream input must include recent experience. */
async function caseDreamInputIncludesExperience() {
  await withRuntime(async ({ runtime }) => {
    for (const line of ['黑莓今天睡沙发', '主人今天有点难过', '花花陪着主人']) {
      await runtime.chat(line)
    }

    const context = await runtime.recentExperienceContext({ limit: 12 })
    assert.ok(context, 'recent experience context must be available')
    assert.ok(context.entries.length >= 3, `expected >=3 experiences in dream input, got ${context.entries.length}`)
    assert.ok(
      context.entries.some((entry) => String(entry.content).includes('沙发')),
      `dream input must carry the sofa experience, got ${JSON.stringify(context.entries.map((e) => e.content))}`,
    )
    assert.ok(typeof context.rendered === 'string' && context.rendered.length > 0, 'dream input must render to text')
    console.log('CASE_5_DREAM_INPUT_INCLUDES_EXPERIENCE=PASS')
  })
}

async function main() {
  await caseExplicitMemorySurvivesChitchat()
  await caseRepeatedBehaviourBecomesCandidate()
  await caseExplicitBirthdayEntersQueue()
  await caseReflectionConsumesBuffer()
  await caseDreamInputIncludesExperience()
  console.log('VC_AI_PET_V0_4_EXPERIENCE_AWARE_MEMORY_ACCEPTANCE=PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
