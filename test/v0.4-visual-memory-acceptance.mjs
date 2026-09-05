import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { detectLongTermVisualIntent } from '../src/vision/long-term-visual-recall.js'
import { visualTermsFor } from '../src/vision/visual-keywords.js'

const IMAGE_A = 'data:image/png;base64,QUFB'
const IMAGE_B = 'data:image/png;base64,QkJC'
const IMAGE_C = 'data:image/png;base64,Q0ND'

function visualStepAnswer(observation = '看到了一盆开花的植物。', reply = '那是一盆开花的植物。') {
  return () => ({ ok: true, observation, action: 'answer', nextVisualId: '', focus: '', replyMessages: [reply] })
}

function fakeVisualBrain(calls, step) {
  return {
    visualStep: async (request) => { calls.push(request); return step(request, calls.length) },
    reply: async () => ({ ok: true, text: '你好呀主人。', replyMessages: ['你好呀主人。'] }),
  }
}

async function saveImage(store, dataUrl, width = 64, height = 64) {
  return store.saveAttachment({ image: { dataUrl }, thumbnail: { dataUrl }, width, height, thumbnailWidth: width, thumbnailHeight: height, requireThumbnail: true })
}

async function runTurn(runtime, userText, attachmentId = null) {
  const started = runtime.startChatTurn({ userText, attachmentId })
  let poll = null
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    poll = runtime.pollChatTurn(started.turnId, 0)
    if (poll?.status !== 'running') break
  }
  return poll
}

const roots = []

// ---------------------------------------------------------------- A + C + B
{
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-accept-a-'))
  roots.push(root)
  const runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  const calls = []
  runtime.brain = fakeVisualBrain(calls, visualStepAnswer())
  const store = runtime.conversationStore

  const plant = await saveImage(store, IMAGE_A)
  await store.appendMessage({ role: 'user', text: '这盆植物真好看', attachment: plant, timestamp: 1000 })
  // Over 600 ordinary messages evict the image turn from the 500-message
  // recent window: only the Long-Term Visual Experience Index can find it.
  for (let index = 0; index < 610; index += 1) {
    await store.appendMessage({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `普通消息 ${index}`,
      timestamp: 2000 + index,
    })
  }
  const originalDataUrl = (await store.readAttachmentDataUrl(plant.id)).dataUrl
  const turnA = await runTurn(runtime, '以前那盆植物是什么样子的？')
  assert.equal(turnA?.status, 'done')
  assert.equal(turnA.result.replyMessages[0], '那是一盆开花的植物。')
  assert.equal(calls.length, 1, 'A: 长期回想必须真正重开原图并调用一次 Vision')
  assert.equal(calls[0].image.dataUrl, originalDataUrl, 'C: Vision 收到的是重新读取的原图字节，不是旧 caption')
  assert.equal(turnA.events.some((event) => event.type === 'visual_recall'), true, 'A: 应产生 visual_recall 回想事件')
  assert.equal(turnA.events.some((event) => event.type === 'visual_image'), true, 'A: 应展示历史原图 media_ref')
  assert.equal(turnA.result.reasoning.visualInspections, 1)
  console.log('ACCEPTANCE_A_OVER_600_MESSAGES_RECALL=PASS')
  console.log('ACCEPTANCE_C_ORIGINAL_IMAGE_REOPEN=PASS')

  // ---------------------------------------------------------------- B
  runtime.close()
  const restarted = new PetRuntime({ sandboxRoot: root })
  await restarted.initialize()
  const restartCalls = []
  restarted.brain = fakeVisualBrain(restartCalls, visualStepAnswer('重新看过了，还是那盆植物。', '是以前那盆植物，花花重新看过了。'))
  const turnB = await runTurn(restarted, '你还记得以前那盆植物吗')
  assert.equal(turnB?.status, 'done')
  assert.equal(turnB.result.replyMessages[0], '是以前那盆植物，花花重新看过了。')
  assert.equal(restartCalls.length, 1)
  assert.equal(restartCalls[0].image.dataUrl, originalDataUrl, 'B: 重启后仍能找到并重开原图')
  assert.equal(await restarted.visualExperience.countExperiences(), 1, 'B: 重启 backfill 幂等，不得重复创建 experience')
  console.log('ACCEPTANCE_B_RESTART_RECALL=PASS')

  // ---------------------------------------------------------------- I + J
  const cat = await saveImage(restarted.conversationStore, IMAGE_B)
  await restarted.conversationStore.appendMessage({ role: 'user', text: '这只猫好可爱', attachment: cat, timestamp: 500000 })
  const catCalls = []
  restarted.brain = fakeVisualBrain(catCalls, visualStepAnswer('看到了一只猫。', '是那只猫。'))
  const turnJ = await runTurn(restarted, '以前那只猫长什么样？')
  assert.equal(turnJ?.status, 'done')
  assert.equal(catCalls.length, 1)
  assert.equal(await restarted.visualExperience.countRawRoots(), 2, 'J: 两张独立图片 = 2 个 raw evidence roots')
  const plantExperience = await restarted.visualExperience.findExperienceByAttachmentId(plant.id)
  // Turns A and B already inspected the same original twice; push the total
  // to ten inspections of one image and prove the raw root count never grows.
  for (let extra = 0; extra < 8; extra += 1) {
    await restarted.visualExperience.recordEvent({ experienceId: plantExperience.experienceId, kind: 'revisit', turnId: `turn-extra-${extra}`, occurredAt: 600000 + extra })
  }
  assert.equal(await restarted.visualExperience.countRawRoots(), 2, 'I: 同一图片累计看 10 次 raw evidence roots 不变')
  assert.equal((await restarted.visualExperience.findExperienceById(plantExperience.experienceId)).inspectionCount, 10, 'I: 10 次查看只计一个 raw root')
  console.log('ACCEPTANCE_I_REPEATED_IMAGE_RAW_ROOT_DEDUP=PASS')
  console.log('ACCEPTANCE_J_TWO_IMAGES_TWO_ROOTS=PASS')
  restarted.close()
}

// ---------------------------------------------------------------- G + H
{
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-accept-gh-'))
  roots.push(root)
  const runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  const calls = []
  runtime.brain = fakeVisualBrain(calls, visualStepAnswer('这碗面有蘑菇。', '刚才那碗面里有蘑菇。'))
  const store = runtime.conversationStore
  const dish = await saveImage(store, IMAGE_B)
  await store.appendMessage({ role: 'user', text: '这盘菜', attachment: dish, timestamp: 1000 })
  const noodle = await saveImage(store, IMAGE_A)
  await store.appendMessage({ role: 'user', text: '这碗面', attachment: noodle, timestamp: 1002 })

  let longTermSearches = 0
  const searchByTerms = runtime.visualExperience.searchByTerms.bind(runtime.visualExperience)
  runtime.visualExperience.searchByTerms = async (...args) => { longTermSearches += 1; return searchByTerms(...args) }
  assert.equal(detectLongTermVisualIntent('刚才的面是什么味道'), null, 'G: 立即时间词不得触发长期视觉')

  const turnG = await runTurn(runtime, '刚才的面是什么味道')
  assert.equal(turnG?.status, 'done')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].image.dataUrl, (await store.readAttachmentDataUrl(noodle.id)).dataUrl, 'G: 刚才的面仍走 Recent Visual')
  assert.equal(turnG.events.some((event) => event.type === 'visual_recall'), false, 'G: Recent 路径不产生长期回想事件')
  assert.equal(longTermSearches, 0, 'G: Recent 命中时不得查询长期视觉库')
  console.log('ACCEPTANCE_G_RECENT_VISUAL_PRIORITY=PASS')

  const beforeCalls = calls.length
  const turnH = await runTurn(runtime, '花花你好')
  assert.equal(turnH?.status, 'done')
  assert.equal(turnH.events.some((event) => event.type === 'visual_selected' || event.type === 'visual_recall'), false)
  assert.equal(calls.length, beforeCalls, 'H: 普通问候不得启动 Vision')
  assert.equal(longTermSearches, 0, 'H: 普通问候不得做长期视觉检索')
  console.log('ACCEPTANCE_H_GREETING_ZERO_VISION=PASS')
  runtime.close()
}

// ---------------------------------------------------------------- D
{
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-accept-d-'))
  roots.push(root)
  const runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  const store = runtime.conversationStore
  const orchid = await saveImage(store, IMAGE_A)
  await store.appendMessage({ role: 'user', text: '这盆植物', attachment: orchid, timestamp: 1000 })
  // Evict the image turn from the recent window so retrieval must use the
  // Long-Term index (user_text) while the wrong observation only assists.
  for (let index = 0; index < 610; index += 1) {
    await store.appendMessage({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `普通消息 ${index}`,
      timestamp: 2000 + index,
    })
  }
  await runtime.syncVisualExperiences()
  const experience = await runtime.visualExperience.findExperienceByAttachmentId(orchid.id)
  // A WRONG old observation: it may assist retrieval but must never become
  // the final visual fact. The original image is reopened instead.
  await runtime.visualExperience.recordEvent({
    experienceId: experience.experienceId,
    kind: 'observation',
    summary: '这盆是仙人掌',
    terms: visualTermsFor('仙人掌', { boost: 1 }),
    occurredAt: 2000,
  })
  const calls = []
  runtime.brain = fakeVisualBrain(calls, visualStepAnswer('重新看过了，其实是兰花。', '花花重新看了原图，其实是兰花。'))
  const turnD = await runTurn(runtime, '以前那盆植物是什么？')
  assert.equal(turnD?.status, 'done')
  assert.equal(calls.length, 1, 'D: 必须重开原图')
  assert.match(turnD.result.replyMessages.join('\n'), /兰花/u)
  assert.doesNotMatch(turnD.result.replyMessages.join('\n'), /仙人掌/u, 'D: 旧 observation 不得冒充当前观察')
  const observations = await runtime.visualExperience.recentObservationsFor(experience.experienceId, { limit: 10 })
  assert.equal(observations.some((event) => event.summary.includes('兰花') && event.evidence === 'inferred'), true)
  console.log('ACCEPTANCE_D_WRONG_OBSERVATION_ASSISTS_ONLY=PASS')
  runtime.close()
}

// ---------------------------------------------------------------- E
{
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-accept-e-'))
  roots.push(root)
  const runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  const store = runtime.conversationStore
  const first = await saveImage(store, IMAGE_A)
  const second = await saveImage(store, IMAGE_B)
  await store.appendMessage({ role: 'user', text: '那盆植物', attachment: first, timestamp: 1000 })
  await store.appendMessage({ role: 'user', text: '那盆植物', attachment: second, timestamp: 1001 })
  await runtime.syncVisualExperiences()
  const calls = []
  runtime.brain = fakeVisualBrain(calls, visualStepAnswer('看到了。', '看到了。'))
  const turnE = await runTurn(runtime, '以前那盆植物')
  assert.equal(turnE?.status, 'done')
  assert.equal(calls.length, 0, 'E: 并列候选不得调用 Vision')
  assert.match(turnE.result.replyMessages.join('\n'), /哪一张/u, 'E: 无 winner 必须 AMBIGUOUS 反问')
  console.log('ACCEPTANCE_E_AMBIGUITY_GUARD=PASS')
  runtime.close()
}

// ---------------------------------------------------------------- F
{
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-accept-f-'))
  roots.push(root)
  const runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  const store = runtime.conversationStore
  const plant = await saveImage(store, IMAGE_A)
  await store.appendMessage({ role: 'user', text: '这盆植物', attachment: plant, timestamp: 1000 })
  const distractor = await saveImage(store, IMAGE_B)
  await store.appendMessage({ role: 'user', text: '这盘菜', attachment: distractor, timestamp: 1001 })
  await store.appendMessage({ role: 'assistant', kind: 'final', text: '这是兰花哦。', timestamp: 1002 })
  await runtime.syncVisualExperiences()
  const calls = []
  runtime.brain = fakeVisualBrain(calls, visualStepAnswer('看到了。', '看到了。'))
  // '兰花' 只出现在 assistant 旧回复里：它不能成为 raw retrieval evidence。
  const turnF = await runTurn(runtime, '以前那朵兰花')
  assert.equal(turnF?.status, 'done')
  assert.equal(calls.length, 0, 'F: assistant 旧回复不得成为检索证据，也不得启动 Vision')
  assert.match(turnF.result.replyMessages.join('\n'), /没有找到/u)
  console.log('ACCEPTANCE_F_ASSISTANT_EVIDENCE_EXCLUDED=PASS')
  runtime.close()
}

// ---------------------------------------------------------------- K
{
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-accept-k-'))
  roots.push(root)
  const runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  await runtime.visualExperience.syncMessage({
    id: 'message-ghost',
    role: 'user',
    text: '这盆植物',
    timestamp: 1000,
    attachment: { id: 'ghost-attachment' },
  }, {
    tokenizeText: (text, { boost }) => visualTermsFor(text, { boost }),
  })
  const calls = []
  runtime.brain = fakeVisualBrain(calls, visualStepAnswer('看到了。', '看到了。'))
  const turnK = await runTurn(runtime, '以前那盆植物')
  assert.equal(turnK?.status, 'done')
  assert.equal(calls.length, 0, 'K: asset 缺失不得调用 Vision')
  assert.match(turnK.result.replyMessages.join('\n'), /原图找不到/u, 'K: 坦诚无法重新确认，不拿旧 caption 冒充')
  console.log('ACCEPTANCE_K_MISSING_ASSET_HONEST=PASS')
  runtime.close()
}

// ------------------------------------------------------ Backfill acceptance
{
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-accept-backfill-'))
  roots.push(root)
  const legacy = []
  for (let index = 0; index < 42; index += 1) {
    legacy.push({
      id: `legacy-image-${index}`,
      role: 'user',
      text: `历史植物图片 ${index}`,
      timestamp: 1000 + index,
      attachment: {
        id: `legacy-att-${index}`,
        mimeType: 'image/png',
        originalMimeType: 'image/png',
        thumbnailMimeType: 'image/png',
        thumbnailOriginalMimeType: 'image/png',
        width: 64,
        height: 64,
        thumbnailWidth: 64,
        thumbnailHeight: 64,
        size: 4,
        thumbnailSize: 4,
        assetPath: `conversation-assets/2026/09/01/legacy-att-${index}.png`,
        thumbnailPath: `conversation-assets/2026/09/01/legacy-att-${index}-thumbnail.png`,
        createdAt: 1000 + index,
      },
    })
  }
  await writeFile(join(root, 'conversation-store.json'), JSON.stringify({ version: 1, messages: legacy, attachments: [] }))
  const filesBefore = (await readdir(root)).sort()

  const runtime = new PetRuntime({ sandboxRoot: root })
  const originalSync = runtime.visualExperience.syncFromArchive.bind(runtime.visualExperience)
  let backfillResult = null
  runtime.visualExperience.syncFromArchive = async (...args) => {
    const result = await originalSync(...args)
    backfillResult = result
    return result
  }
  await runtime.initialize()
  assert.ok(backfillResult, 'backfill 必须实际执行')
  assert.equal(backfillResult.modelCalls, 0, 'MODEL_CALLS_DURING_BACKFILL=0')
  assert.equal(backfillResult.petMemoryWrites, 0, 'PET_MEMORY_WRITES_DURING_BACKFILL=0')
  assert.equal(backfillResult.dreamRuns, 0, 'DREAM_RUNS_DURING_BACKFILL=0')
  assert.equal(backfillResult.createdCount, 42)
  assert.equal(await runtime.visualExperience.countExperiences(), 42)
  const filesAfter = (await readdir(root)).sort()
  assert.equal(filesBefore.every((name) => filesAfter.includes(name)), true, 'backfill 不得删除既有文件')
  assert.equal(filesAfter.some((name) => name.startsWith('legacy-att')), false, '原图 UNCHANGED')
  // conversation-assets/ is created empty by ConversationStore.initialize;
  // backfill itself must never write image files into it.
  const assetsEntries = await readdir(join(root, 'conversation-assets'))
  assert.deepEqual(assetsEntries, [], 'backfill 不得写入任何图片文件')
  console.log('BACKFILL_MODEL_CALLS=0')
  console.log('BACKFILL_PET_MEMORY_WRITES=0')
  console.log('BACKFILL_DREAM_RUNS=0')
  console.log('BACKFILL_IMAGES_UNCHANGED=PASS')
  runtime.close()

  const second = new PetRuntime({ sandboxRoot: root })
  await second.initialize()
  assert.equal(await second.visualExperience.countExperiences(), 42, 'backfill 重启幂等')
  console.log('BACKFILL_RESTART_IDEMPOTENT=PASS')
  second.close()
}

// ---------------------------------------------------------------- cleanup
for (const root of roots) {
  await rm(root, { recursive: true, force: true })
}

console.log('VISUAL_MEMORY_ACCEPTANCE=PASS')
