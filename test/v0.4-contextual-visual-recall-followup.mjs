import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { detectLongTermVisualIntent } from '../src/vision/long-term-visual-recall.js'
import { MAX_VISUAL_INSPECTIONS_PER_TURN } from '../src/vision/visual-working-session.js'
import { detectContextualVisualRecallFollowUp } from '../src/runtime/visual-recall-context.js'
import { visualTermsFor } from '../src/vision/visual-keywords.js'

const IMAGE_FIG = 'data:image/png;base64,RklH'
const IMAGE_SHINCHAN = 'data:image/png;base64,U0hJTkNIQU4='
const IMAGE_NOODLE = 'data:image/png;base64,Tk9PRExF'
const IMAGE_A = 'data:image/png;base64,QQ=='
const IMAGE_B = 'data:image/png;base64,Qg=='

async function saveImage(store, dataUrl, width = 64, height = 64) {
  return store.saveAttachment({
    image: { dataUrl },
    thumbnail: { dataUrl },
    width,
    height,
    thumbnailWidth: width,
    thumbnailHeight: height,
    requireThumbnail: true,
  })
}

function visualAnswer(calls, { observation = '原图里有很多无花果。', reply = '花花重新确认到了。', steps = null } = {}) {
  return {
    visualStep: async (request) => {
      calls.push(request)
      if (Array.isArray(steps)) return steps[calls.length - 1] ?? steps.at(-1)
      return { ok: true, observation, action: 'answer', nextVisualId: '', focus: '果实', replyMessages: [reply] }
    },
    reply: async ({ userText }) => ({ ok: true, text: `普通回答：${userText}`, replyMessages: [`普通回答：${userText}`] }),
  }
}

async function runTurn(runtime, userText, attachmentId = null) {
  const started = runtime.startChatTurn({ userText, attachmentId })
  let poll = null
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    poll = runtime.pollChatTurn(started.turnId, 0)
    if (poll?.status !== 'running') break
  }
  assert.notEqual(poll?.status, 'running', `turn did not finish: ${userText}`)
  return poll
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-contextual-recall-'))
  const textRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-contextual-text-'))
  const multiRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-contextual-multi-'))
  const runtime = new PetRuntime({ sandboxRoot: root })
  const textRuntime = new PetRuntime({ sandboxRoot: textRoot })
  const multiRuntime = new PetRuntime({ sandboxRoot: multiRoot })

  try {
    await runtime.initialize()
    const store = runtime.conversationStore
    const fig = await saveImage(store, IMAGE_FIG)
    await store.appendMessage({ role: 'user', text: '无花果', attachment: fig, timestamp: 100 })
    await runtime.syncVisualExperiences()

    const visualCalls = []
    runtime.brain = visualAnswer(visualCalls)
    let longTermSearches = 0
    const originalSearch = runtime.visualExperience.searchByTerms.bind(runtime.visualExperience)
    runtime.visualExperience.searchByTerms = async (...args) => {
      longTermSearches += 1
      return originalSearch(...args)
    }

    // CASE A + D: a prior historical visual request asked for clarification;
    // a descriptive answer must retry retrieval even when it has no candidate,
    // and the next contextual correction must find the real fig image.
    const failureMessage = '算了那你想想无花果吧'
    const clarificationMessage = '就是有很多用像素珠拼成的食物图案哦'
    assert.equal(detectLongTermVisualIntent(failureMessage), null, 'A: message-only detector must stay conservative')
    assert.ok(detectContextualVisualRecallFollowUp(failureMessage), 'A: active-frame follow-up detector must see the subject')
    runtime.turnOrchestrator.recallContext.record({
      mode: 'visual_recall_ambiguous',
      query: '你还记得以前给你发的那张图片吗',
      result: { status: 'ambiguous' },
    })
    const clarificationPlan = runtime.turnOrchestrator.planFollowUp(clarificationMessage)
    assert.equal(clarificationPlan?.clarification, true, 'D: clarification frame must be carried into the retry')
    assert.equal(clarificationPlan?.retryOnNone, true, 'D: clarification must retry even without a current candidate')
    const searchesBeforeClarification = longTermSearches
    const clarificationTurn = await runTurn(runtime, clarificationMessage)
    assert.equal(clarificationTurn?.status, 'done')
    assert.equal(visualCalls.length, 0, 'D: no candidate means no fake Vision inspection')
    assert.ok(longTermSearches > searchesBeforeClarification, 'D: clarification must execute Long-Term retrieval')
    assert.equal(runtime.turnOrchestrator.recallContextActive(), true, 'D: failed clarification must preserve the ephemeral frame')
    console.log('CLARIFICATION_CONTINUES_VISUAL_RECALL=PASS')

    const finalPlan = runtime.turnOrchestrator.planFollowUp(failureMessage)
    assert.equal(finalPlan?.kind, 'subject_correction', 'A: 算了... subject change is a correction')
    const recalledDataUrl = (await store.readAttachmentDataUrl(fig.id)).dataUrl
    const failureTurn = await runTurn(runtime, failureMessage)
    assert.equal(failureTurn?.status, 'done')
    assert.equal(visualCalls.length, 1, 'A: contextual fig follow-up must run Vision')
    assert.equal(visualCalls[0].image.dataUrl, recalledDataUrl, 'A: contextual recall must reopen the original attachment')
    assert.equal(failureTurn.events.some((event) => event.type === 'visual_recall'), true, 'A: long-term recall event must be emitted')
    assert.equal(failureTurn.events.filter((event) => event.type === 'visual_image').length, 1, 'presentation: recalled image renders once')
    assert.equal(failureTurn.events.filter((event) => event.type === 'visual_observation').every((event) => event.payload.summary === '👀 花花重新看了看'), true, 'presentation: full observation stays out of visible activity')
    assert.ok(failureTurn.result.replyMessages.length <= 2, 'presentation: final has at most two bubbles')
    assert.equal(failureTurn.result.reasoning.visualInspections, 1, 'A: one original-image reinspection')
    console.log('CONTEXTUAL_FIG_RECALL=PASS')
    console.log('ORIGINAL_IMAGE_REOPEN=PASS')
    console.log('LOCAL_BRAIN_REINSPECTION=PASS')

    // CASE B: a topic continuation uses the active frame but remains subject
    // specific, so it does not become a generic visual trigger.
    runtime.turnOrchestrator.recallContext.record({
      mode: 'visual_recall_ambiguous',
      query: '你还记得以前给你发的那张图片吗',
      result: { status: 'ambiguous' },
    })
    const topicPlan = runtime.turnOrchestrator.planFollowUp('那无花果呢')
    assert.equal(topicPlan?.kind, 'topic_shift')
    const topicTurn = await runTurn(runtime, '那无花果呢')
    assert.equal(topicTurn?.status, 'done')
    assert.equal(visualCalls.length, 2, 'B: topic continuation must run Long-Term Vision')
    console.log('TOPIC_CONTINUATION_LONG_TERM=PASS')

    // CASE C: correction must retry the historical resolver rather than keep
    // chatting about the wrong candidate.
    runtime.turnOrchestrator.recallContext.record({
      mode: 'visual_recall_ambiguous',
      query: '你还记得以前给你发的那张图片吗',
      result: { status: 'ambiguous' },
    })
    const correctionText = '不是这个，我说的是无花果'
    const correctionPlan = runtime.turnOrchestrator.planFollowUp(correctionText)
    assert.equal(correctionPlan?.kind, 'subject_correction')
    assert.equal(correctionPlan?.retryOnNone, true)
    const correctionTurn = await runTurn(runtime, correctionText)
    assert.equal(correctionTurn?.status, 'done')
    assert.equal(visualCalls.length, 3, 'C: subject correction must rerun Long-Term Vision')
    console.log('SUBJECT_CORRECTION_LONG_TERM_RETRY=PASS')

    // CASE H: explicit historical wording remains unchanged.
    assert.equal(detectLongTermVisualIntent('你记得我之前给你发的那盆无花果吗')?.mode, 'long-term-visual')
    const explicitTurn = await runTurn(runtime, '你记得我之前给你发的那盆无花果吗')
    assert.equal(explicitTurn?.status, 'done')
    assert.equal(visualCalls.length, 4, 'H: explicit long-term recall must still run Vision')
    console.log('EXPLICIT_LONG_TERM_REGRESSION=PASS')

    // CASE I: an observation-only legacy clue remains usable for retrieval,
    // while the original attachment is still reopened for the answer.
    const shinchan = await saveImage(store, IMAGE_SHINCHAN)
    await store.appendMessage({ role: 'user', text: '这张图', attachment: shinchan, timestamp: 200 })
    await runtime.syncVisualExperiences()
    const shinchanExperience = await runtime.visualExperience.findExperienceByAttachmentId(shinchan.id)
    await runtime.visualExperience.recordEvent({
      experienceId: shinchanExperience.experienceId,
      kind: 'observation',
      summary: '蜡笔小新',
      terms: visualTermsFor('蜡笔小新', { boost: 1 }),
      evidence: 'inferred',
      occurredAt: 300,
    })
    const legacyTurn = await runTurn(runtime, '你记得我以前给你看的蜡笔小新吗')
    assert.equal(legacyTurn?.status, 'done')
    assert.equal(visualCalls.length, 5, 'I: legacy observation recall must run Vision')
    assert.equal(visualCalls.at(-1).image.dataUrl, (await store.readAttachmentDataUrl(shinchan.id)).dataUrl)
    console.log('LEGACY_OBSERVATION_RECALL=PASS')

    // CASE J: immediate wording remains Recent Visual and does not query the
    // long-term index or emit a long-term recall activity.
    const noodle = await saveImage(store, IMAGE_NOODLE)
    await store.appendMessage({ role: 'user', text: '这碗面', attachment: noodle, timestamp: 400 })
    await runtime.syncVisualExperiences()
    runtime.turnOrchestrator.clearVisualRecallContext()
    const searchesBeforeRecent = longTermSearches
    const recentTurn = await runTurn(runtime, '刚才那张面呢')
    assert.equal(recentTurn?.status, 'done')
    assert.equal(visualCalls.length, 6, 'J: Recent Visual must still inspect the latest image')
    assert.equal(visualCalls.at(-1).image.dataUrl, (await store.readAttachmentDataUrl(noodle.id)).dataUrl)
    assert.equal(recentTurn.events.some((event) => event.type === 'visual_recall'), false, 'J: Recent Visual must not emit long-term recall')
    assert.equal(longTermSearches, searchesBeforeRecent, 'J: Recent Visual must not query Long-Term')
    console.log('RECENT_VISUAL_REGRESSION=PASS')

    // CASE E-G: without an active visual frame, recall-like verbs remain
    // ordinary text and cannot start Vision.
    await textRuntime.initialize()
    const textVisualCalls = []
    const textReplyCalls = []
    textRuntime.brain = {
      visualStep: async (request) => { textVisualCalls.push(request); return { ok: true, observation: '不应执行', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['不应执行'] } },
      reply: async ({ userText }) => { textReplyCalls.push(userText); return { ok: true, text: '普通聊天回答', replyMessages: ['普通聊天回答'] } },
    }
    const falsePositiveCases = [
      ['你想想晚上吃什么', 'FALSE_POSITIVE_DINNER'],
      ['你想想这道数学题', 'FALSE_POSITIVE_MATH'],
      ['你看看今天是不是会下雨', 'FALSE_POSITIVE_WEATHER'],
    ]
    for (const [text, label] of falsePositiveCases) {
      assert.equal(detectLongTermVisualIntent(text), null, `${label}: message-only long-term detector must be NO`)
      const ordinaryTurn = await runTurn(textRuntime, text)
      assert.equal(ordinaryTurn?.status, 'done')
      assert.equal(ordinaryTurn.events.some((event) => event.type === 'visual_recall' || event.type === 'visual_image'), false, `${label}: ordinary text must not run visual route`)
      console.log(`${label}=PASS`)
    }
    assert.equal(textVisualCalls.length, 0)
    assert.equal(textReplyCalls.length, 3)

    // CASE K: the existing bounded comparison protocol remains A -> B -> A
    // and never exceeds the global five-inspection cap.
    await multiRuntime.initialize()
    const multiStore = multiRuntime.conversationStore
    const imageA = await saveImage(multiStore, IMAGE_A)
    const imageB = await saveImage(multiStore, IMAGE_B)
    await multiStore.appendMessage({ role: 'user', text: '第一张图', attachment: imageA, timestamp: 100 })
    await multiStore.appendMessage({ role: 'user', text: '第二张图', attachment: imageB, timestamp: 200 })
    await multiRuntime.syncVisualExperiences()
    const multiCalls = []
    multiRuntime.brain = visualAnswer(multiCalls, {
      steps: [
        { ok: true, observation: 'A', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['过早答案'] },
        { ok: true, observation: 'B', action: 'inspect', nextVisualId: 'V0', focus: '', replyMessages: [] },
        { ok: true, observation: 'A', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['A 和 B 看完了。'] },
      ],
    })
    const multiTurn = await runTurn(multiRuntime, '两张图找不同', imageA.id)
    assert.equal(multiTurn?.status, 'done')
    assert.deepEqual(multiCalls.map((request) => request.image.dataUrl), [IMAGE_A, IMAGE_B, IMAGE_A], 'K: comparison must inspect A -> B -> A')
    assert.ok(multiCalls.length <= MAX_VISUAL_INSPECTIONS_PER_TURN, 'K: comparison must honor five-inspection cap')
    assert.equal(multiTurn.result.reasoning.visualUniqueImages, 2)
    console.log('MULTI_VISUAL_A_B_A=PASS')
    console.log('FIVE_INSPECTION_CAP=PASS')
  } finally {
    runtime.close()
    textRuntime.close()
    multiRuntime.close()
    await rm(root, { recursive: true, force: true })
    await rm(textRoot, { recursive: true, force: true })
    await rm(multiRoot, { recursive: true, force: true })
  }
}

await main()
console.log('CONTEXTUAL_VISUAL_RECALL_FOLLOWUP=PASS')
