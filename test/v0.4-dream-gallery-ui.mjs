import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { startLanServer } from '../src/remote/lan-server.js'
import { readInnerLifeTimeline } from '../src/memory/inner-life-timeline.js'

const IMAGE_A = 'data:image/png;base64,QUFB'
const IMAGE_B = 'data:image/png;base64,QkJC'

async function saveImage(store, dataUrl, timestamp) {
  return store.saveAttachment({
    image: { dataUrl },
    thumbnail: { dataUrl },
    width: 64,
    height: 64,
    thumbnailWidth: 64,
    thumbnailHeight: 64,
    timestamp,
    requireThumbnail: true,
  })
}

const sandbox = await mkdtemp(join(tmpdir(), 'vc-ai-pet-dream-gallery-'))
const runtime = new PetRuntime({ sandboxRoot: sandbox })
let server
try {
  await runtime.initialize()

  const raw = runtime.memory.remember('fact', '主人喜欢窗边的植物。', 2)
  const dreamInsight = runtime.memory.rememberDreamCandidate({
    level: 'fact',
    content: '花花记住了，主人很喜欢窗边的植物。',
    importance: 2,
    sourceIds: [raw.id],
  })
  const hiddenDreamInsight = runtime.memory.rememberDreamCandidate({
    level: 'fact',
    content: 'system prompt: hidden reasoning should never appear',
    importance: 2,
    sourceIds: [raw.id],
  })
  runtime.memory.logDream(
    '花花整理了和主人一起看过的植物。',
    { kind: 'dream', derived: [{ id: dreamInsight.id }, { id: hiddenDreamInsight.id }], sourceIds: [raw.id] },
    'fixture',
  )

  const reflectionInsight = runtime.memory.rememberReflectionCandidate({
    level: 'fact',
    content: '花花发现，主人会留意窗边的变化。',
    importance: 2,
    sourceIds: [raw.id],
  })
  runtime.memory.logReflection(
    '花花又想了一小会儿。',
    { kind: 'reflection', derived: [{ id: reflectionInsight.id }], sourceIds: [raw.id] },
    'fixture',
  )
  runtime.memory.logDream('只有整理，没有新的理解。', { kind: 'dream', derived: [], sourceIds: [raw.id] }, 'fixture')

  const db = runtime.memory.db.db
  const timeline = readInnerLifeTimeline(db, { findById: runtime.memory.db.findById.bind(runtime.memory.db) })
  const dreamItem = timeline.items.find((item) => item.kind === 'dream' && item.insightCount === 2)
  const reflectionItem = timeline.items.find((item) => item.kind === 'reflection')
  const emptyDreamItem = timeline.items.find((item) => item.insightCount === 0)
  assert.ok(dreamItem)
  assert.deepEqual(dreamItem.insights.map((item) => item.content), ['花花记住了，主人很喜欢窗边的植物。'])
  assert.equal(reflectionItem.insights[0].content, '花花发现，主人会留意窗边的变化。')
  assert.deepEqual(emptyDreamItem.insights, [])
  assert.doesNotMatch(JSON.stringify(timeline), /system prompt|hidden reasoning|sourceIds|PRIVATE/u)

  const store = runtime.conversationStore
  const attachmentA = await saveImage(store, IMAGE_A, 1000)
  await store.appendMessage({ role: 'user', text: '窗边的植物，主人很喜欢。', attachment: attachmentA, timestamp: 1000 })
  const attachmentB = await saveImage(store, IMAGE_B, 2000)
  await store.appendMessage({ role: 'user', text: '另一张窗边照片。', attachment: attachmentB, timestamp: 2000 })
  await runtime.syncVisualExperiences()
  const experienceA = await runtime.visualExperience.findExperienceByAttachmentId(attachmentA.id)
  const experienceB = await runtime.visualExperience.findExperienceByAttachmentId(attachmentB.id)
  assert.ok(experienceA && experienceB)

  await runtime.visualExperience.recordEvent({ experienceId: experienceA.experienceId, kind: 'inspection', occurredAt: 3000, focus: '植物' })
  await runtime.visualExperience.recordEvent({
    experienceId: experienceA.experienceId,
    kind: 'observation',
    occurredAt: 4000,
    summary: '花盆里的植物比以前更茂盛。',
    terms: [{ term: '植物', weight: 5 }, { term: '茂盛', weight: 4 }, { term: '看', weight: 9 }],
  })
  await runtime.visualExperience.recordEvent({ experienceId: experienceA.experienceId, kind: 'revisit', occurredAt: 5000 })
  await runtime.visualExperience.recordEvent({
    experienceId: experienceA.experienceId,
    kind: 'comparison',
    occurredAt: 6000,
    summary: '和另一张照片做了对照。',
    relatedExperienceId: experienceB.experienceId,
  })

  const readOnlyCountsBefore = {
    dreamLog: Number(db.prepare('SELECT COUNT(*) AS n FROM dream_log').get().n),
    experiences: Number(runtime.visualExperience.db.prepare('SELECT COUNT(*) AS n FROM visual_experiences').get().n),
    events: Number(runtime.visualExperience.db.prepare('SELECT COUNT(*) AS n FROM visual_events').get().n),
    terms: Number(runtime.visualExperience.db.prepare('SELECT COUNT(*) AS n FROM visual_terms').get().n),
  }

  server = await startLanServer({ runtime, assetRoot: new URL('../assets/runtime/', import.meta.url).pathname, port: 0, logger: { info() {} } })
  const base = `http://127.0.0.1:${server.address().port}`
  const listResponse = await fetch(`${base}/api/visual-gallery?limit=1&offset=0`)
  assert.equal(listResponse.status, 200)
  const list = await listResponse.json()
  assert.equal(list.count, 2)
  assert.equal(list.items.length, 1)
  assert.equal(list.nextOffset, 1)
  assert.match(list.items[0].thumbnailUrl, /\/conversation-assets\//u)
  assert.equal('originalUrl' in list.items[0], false)
  assert.equal('visualEvents' in list.items[0], false)
  assert.doesNotMatch(JSON.stringify(list), /data:image|QUFB|QkJC/u)

  const secondPage = await (await fetch(`${base}/api/visual-gallery?limit=1&offset=1`)).json()
  assert.equal(secondPage.items.length, 1)
  assert.equal(secondPage.nextOffset, null)
  assert.equal((await fetch(`${base}/api/visual-gallery?limit=0`)).status, 400)
  assert.equal((await fetch(`${base}/api/visual-gallery/not-found`)).status, 404)

  const detailResponse = await fetch(`${base}/api/visual-gallery/${encodeURIComponent(experienceA.experienceId)}`)
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json()
  assert.equal(detail.ownerText, '窗边的植物，主人很喜欢。')
  assert.equal(detail.ownerTextProvenance, 'raw')
  assert.match(detail.originalUrl, /\/conversation-assets\//u)
  assert.match(detail.thumbnailUrl, /\/conversation-assets\//u)
  assert.deepEqual(detail.visualEvents.map((event) => event.kind), ['inspection', 'observation', 'revisit', 'comparison'])
  assert.equal(detail.visualEvents.find((event) => event.kind === 'observation').evidence, 'inferred')
  assert.equal(detail.visualEvents.find((event) => event.kind === 'comparison').relatedExperienceId, experienceB.experienceId)
  assert.equal(detail.visualTerms.some((term) => term.term === '植物' && term.sourceKind === 'observation'), true)
  assert.equal(detail.visualTerms.some((term) => term.term === '茂盛' && term.sourceKind === 'observation'), true)
  assert.equal(detail.visualTerms.some((term) => term.term === '看'), false)
  assert.equal(detail.debug.rawRoot.attachmentId, experienceA.attachmentId)
  assert.equal(detail.debug.terms.every((term) => ['sourceKind', 'term', 'weight'].every((key) => key in term)), true)
  assert.doesNotMatch(JSON.stringify(detail), /data:image|QUFB|QkJC|reasoning_content|system prompt|hidden reasoning|base64/u)

  const legacyDetail = await (await fetch(`${base}/api/visual-gallery/${encodeURIComponent(experienceB.experienceId)}`)).json()
  assert.equal(legacyDetail.visualEvents.length, 0)
  assert.equal(legacyDetail.hasObservation, false)

  const innerLife = await (await fetch(`${base}/api/inner-life`)).json()
  const apiDream = innerLife.items.find((item) => item.insightCount === 2)
  assert.equal(apiDream.insights[0].content, '花花记住了，主人很喜欢窗边的植物。')
  assert.doesNotMatch(JSON.stringify(apiDream), /sourceIds|hidden reasoning|system prompt|changes/u)
  assert.deepEqual({
    dreamLog: Number(db.prepare('SELECT COUNT(*) AS n FROM dream_log').get().n),
    experiences: Number(runtime.visualExperience.db.prepare('SELECT COUNT(*) AS n FROM visual_experiences').get().n),
    events: Number(runtime.visualExperience.db.prepare('SELECT COUNT(*) AS n FROM visual_events').get().n),
    terms: Number(runtime.visualExperience.db.prepare('SELECT COUNT(*) AS n FROM visual_terms').get().n),
  }, readOnlyCountsBefore)

  const html = await (await fetch(base)).text()
  assert.match(html, /chat-gallery/u)
  assert.match(html, /主人和花花一起看过的照片/u)
  assert.match(html, /visual-gallery-detail-view/u)
  const mobile = await readFile(new URL('../src/remote/mobile-ui/mobile.js', import.meta.url), 'utf8')
  assert.match(mobile, /查看这次花花想明白了什么/u)
  assert.match(mobile, /这次没有形成新的理解/u)
  assert.match(mobile, /花花的观察 · INFERRED/u)
  assert.match(mobile, /originalUrl/u)
  assert.doesNotMatch(mobile, /visualGallery.*innerHTML/u)

  console.log('DREAM_SAFE_PERSISTED_INSIGHTS=PASS')
  console.log('REFLECTION_SAFE_PERSISTED_INSIGHTS=PASS')
  console.log('DREAM_EMPTY_CONCLUSION=PASS')
  console.log('VISUAL_GALLERY_PAGINATED_METADATA=PASS')
  console.log('VISUAL_GALLERY_THUMBNAIL_ONLY_LIST=PASS')
  console.log('VISUAL_GALLERY_DETAIL_EVENTS_TERMS=PASS')
  console.log('VISUAL_GALLERY_LEGACY_ROOT=PASS')
  console.log('VISUAL_GALLERY_NO_RAW_OR_REASONING=PASS')
} finally {
  if (server) { const closed = once(server, 'close'); server.close(); await closed }
  runtime.close()
  await rm(sandbox, { recursive: true, force: true })
}
