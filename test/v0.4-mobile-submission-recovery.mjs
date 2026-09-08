import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const [submissionJs, mobileJs, indexHtml] = await Promise.all([
  readFile(join(root, 'src/remote/mobile-ui/submission-state.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/index.html'), 'utf8'),
])

const context = {}
vm.createContext(context)
vm.runInContext(submissionJs, context, { filename: 'submission-state.js' })
const { SUBMISSION_STAGE, createSubmissionController } = context.VcAiPetSubmission

const image = {
  dataUrl: 'data:image/webp;base64,AAAA',
  thumbnailDataUrl: 'data:image/webp;base64,BBBB',
  width: 12,
  height: 12,
}

function networkFailure(message = 'network lost') {
  return Object.assign(new Error(message), { code: 'FRONTEND_FETCH_ERROR' })
}

function safeStartFailure(message = 'start explicitly rejected', { code = 'turn-capacity', httpStatus = 503 } = {}) {
  return Object.assign(new Error(message), { code, httpStatus, safePreAcceptFailure: true })
}

function createHarness({ upload, runs = [] } = {}) {
  let uploadCount = 0
  let runCount = 0
  let startCount = 0
  let optimisticCount = 0
  let visibleUserNodes = []
  const restored = []
  const accepted = []
  const acceptedFailures = []
  const completed = []
  const serverFailures = []
  const startAcceptanceUnknown = []
  const pollRetries = []
  const retryDelays = []
  let archiveEquivalentUserMessageCount = 0

  const controller = createSubmissionController({
    uploadImage: async (pendingImage) => {
      uploadCount += 1
      if (upload) return upload(pendingImage, uploadCount)
      return { id: `attachment-${uploadCount}` }
    },
    runTurnProgress: async (args) => {
      runCount += 1
      if (!args.turnId) {
        startCount += 1
        args.onStartInFlight?.()
      }
      const run = runs.shift()
      if (!run) throw new Error('missing fixture run')
      return run(args)
    },
    onOptimisticUser: () => {
      optimisticCount += 1
      const node = { removed: false }
      visibleUserNodes = [...visibleUserNodes, node]
      return node
    },
    onAccepted: (state) => accepted.push({ stage: state.stage, turnId: state.turnId }),
    onCompleted: (state) => completed.push({ stage: state.stage, turnId: state.turnId }),
    onPreAcceptFailure: (state) => {
      state.optimisticUserNode.removed = true
      restored.push({ draftText: state.draftText, pendingImage: state.pendingImage })
    },
    onAcceptedFailure: (state) => acceptedFailures.push({ stage: state.stage, turnId: state.turnId }),
    onStartAcceptanceUnknown: (state) => startAcceptanceUnknown.push({ stage: state.stage, turnId: state.turnId }),
    onPollRetry: (state, details) => pollRetries.push({ stage: state.stage, turnId: state.turnId, ...details }),
    onServerFailure: (state) => {
      serverFailures.push({ stage: state.stage, turnId: state.turnId })
      archiveEquivalentUserMessageCount += 1
    },
    waitForPollRetry: async (delayMs) => { retryDelays.push(delayMs) },
  })

  return {
    controller,
    get uploadCount() { return uploadCount },
    get runCount() { return runCount },
    get startCount() { return startCount },
    get optimisticCount() { return optimisticCount },
    get visibleUserCount() { return visibleUserNodes.filter((node) => !node.removed).length },
    get restored() { return restored },
    get accepted() { return accepted },
    get acceptedFailures() { return acceptedFailures },
    get completed() { return completed },
    get serverFailures() { return serverFailures },
    get startAcceptanceUnknown() { return startAcceptanceUnknown },
    get pollRetries() { return pollRetries },
    get retryDelays() { return retryDelays },
    get archiveEquivalentUserMessageCount() { return archiveEquivalentUserMessageCount },
  }
}

function completedRun(turnId) {
  return async ({ onTurnAccepted, onPollProgress, turnId: existingTurnId }) => {
    const effectiveTurnId = existingTurnId || turnId
    if (!existingTurnId) onTurnAccepted(effectiveTurnId)
    onPollProgress({ after: 1, presentation: {}, assistantRendered: true })
    return { stage: SUBMISSION_STAGE.TURN_COMPLETED, turnId: effectiveTurnId, after: 1 }
  }
}

// CASE A: upload fails before an attachment exists. The optimistic user node
// is rolled back and both original composer values are restored.
const caseA = createHarness({
  upload: async () => { throw networkFailure('upload unavailable') },
  runs: [],
})
const caseAResult = await caseA.controller.submit({ draftText: '看这张图', message: '看这张图', pendingImage: image })
assert.equal(caseAResult.status, 'pre-accept-failure')
assert.equal(caseAResult.state.stage, SUBMISSION_STAGE.PRE_UPLOAD)
assert.equal(caseA.visibleUserCount, 0)
assert.deepEqual(caseA.restored, [{ draftText: '看这张图', pendingImage: image }])
assert.equal(caseA.controller.hasActive(), false)

// CASE B / F: upload succeeds but start fails before acceptance. The cached
// attachment is reused by the explicit retry, so upload is performed once.
const uploadedAttachment = { id: 'attachment-stable' }
const caseB = createHarness({
  upload: async () => uploadedAttachment,
  runs: [
    async () => {
      throw safeStartFailure('start explicitly rejected before turn creation')
    },
    completedRun('turn-retry'),
  ],
})
const firstCaseB = await caseB.controller.submit({ draftText: '图片重试', message: '图片重试', pendingImage: image })
assert.equal(firstCaseB.status, 'pre-accept-failure')
assert.equal(firstCaseB.state.stage, SUBMISSION_STAGE.UPLOADED)
assert.equal(firstCaseB.state.uploadedAttachment, uploadedAttachment)
const secondCaseB = await caseB.controller.submit({ draftText: '图片重试', message: '图片重试', pendingImage: image })
assert.equal(secondCaseB.status, 'completed')
assert.equal(caseB.uploadCount, 1)
assert.equal(caseB.startCount, 2)
assert.equal(secondCaseB.state.uploadedAttachment.id, uploadedAttachment.id)
assert.equal(caseB.visibleUserCount, 1)
assert.equal(caseB.optimisticCount, 2)

// CASE C: once accepted, a poll failure keeps ownership and resume uses the
// same turnId and cursor. No second /chat/start is possible on resume.
const caseC = createHarness({
  runs: [
    async ({ onTurnAccepted, onPollProgress }) => {
      onTurnAccepted('turn-owned')
      onPollProgress({ after: 2, presentation: {}, assistantRendered: true })
      throw networkFailure('poll unavailable')
    },
    async ({ turnId, after, onPollProgress }) => {
      assert.equal(turnId, 'turn-owned')
      assert.equal(after, 2)
      onPollProgress({ after: 3, presentation: {}, assistantRendered: true })
      return { stage: SUBMISSION_STAGE.TURN_COMPLETED, turnId, after: 3 }
    },
  ],
})
const caseCResult = await caseC.controller.submit({ draftText: '继续这一条', message: '继续这一条', pendingImage: image })
assert.equal(caseCResult.status, 'accepted-failure')
assert.equal(caseCResult.state.stage, SUBMISSION_STAGE.TURN_ACCEPTED)
assert.equal(caseC.controller.getActiveTurnId(), 'turn-owned')
assert.equal(caseC.visibleUserCount, 1)
const caseCResume = await caseC.controller.resume()
assert.equal(caseCResume.status, 'paused')
const caseCExplicitResume = await caseC.controller.resume({ explicit: true })
assert.equal(caseCExplicitResume.status, 'completed')
assert.equal(caseCExplicitResume.state.stage, SUBMISSION_STAGE.TURN_COMPLETED)
assert.equal(caseCExplicitResume.state.turnId, 'turn-owned')
assert.equal(caseC.startCount, 1)
assert.equal(caseC.runCount, 2)
assert.equal(caseC.uploadCount, 1)
assert.equal(caseC.controller.hasActive(), false)

// CASE D: a terminal server turn_failed keeps the owner bubble and does not
// leave a retryable submission or trigger a new turn automatically.
const caseD = createHarness({
  runs: [
    async ({ onTurnAccepted }) => {
      onTurnAccepted('turn-failed')
      const error = new Error('server turn failed')
      error.code = 'TURN_FAILED'
      throw error
    },
  ],
})
const caseDResult = await caseD.controller.submit({ draftText: '会失败的消息', message: '会失败的消息', pendingImage: null })
assert.equal(caseDResult.status, 'turn-failed')
assert.equal(caseDResult.state.stage, SUBMISSION_STAGE.TURN_FAILED)
assert.equal(caseD.visibleUserCount, 1)
assert.equal(caseD.archiveEquivalentUserMessageCount, 1)
assert.equal(caseD.controller.hasActive(), false)
assert.equal(caseD.controller.getRetryable(), null)
const caseDResume = await caseD.controller.resume()
assert.equal(caseDResume.status, 'idle')
assert.equal(caseD.startCount, 1)

// CASE E: a pre-accept rollback followed by an explicit successful retry
// leaves exactly one visible user bubble.
const caseE = createHarness({
  runs: [
    async () => {
      throw safeStartFailure('message explicitly rejected before turn creation', { code: 'invalid-message', httpStatus: 400 })
    },
    completedRun('turn-eventual-success'),
  ],
})
await caseE.controller.submit({ draftText: '重试后成功', message: '重试后成功', pendingImage: null })
const caseEResult = await caseE.controller.submit({ draftText: '重试后成功', message: '重试后成功', pendingImage: null })
assert.equal(caseEResult.status, 'completed')
assert.equal(caseE.visibleUserCount, 1)

// CASE G: the ordinary successful text+image path still passes with one
// upload, one accepted turn, and the original attachment id.
let caseGArguments = null
const caseG = createHarness({
  upload: async () => uploadedAttachment,
  runs: [
    async (args) => {
      caseGArguments = args
      args.onTurnAccepted('turn-text-image')
      args.onPollProgress({ after: 1, presentation: {}, assistantRendered: true })
      return { stage: SUBMISSION_STAGE.TURN_COMPLETED, turnId: 'turn-text-image', after: 1 }
    },
  ],
})
const caseGResult = await caseG.controller.submit({ draftText: '文字和图片', message: '文字和图片', pendingImage: image })
assert.equal(caseGResult.status, 'completed')
assert.equal(caseG.uploadCount, 1)
assert.equal(caseG.startCount, 1)
assert.equal(caseGArguments.message, '文字和图片')
assert.equal(caseGArguments.attachment.id, uploadedAttachment.id)
assert.equal(caseG.visibleUserCount, 1)

// CASE I / J: once /chat/start has been sent, a lost response is ambiguous.
// The client keeps the optimistic owner node and RAM attachment state, but it
// must not restore a sendable draft or accept an ordinary submit as a retry.
const caseI = createHarness({
  upload: async () => uploadedAttachment,
  runs: [
    async () => {
      const error = networkFailure('start response lost after server acceptance')
      error.serverAccepted = true
      throw error
    },
  ],
})
const caseIResult = await caseI.controller.submit({ draftText: '状态未知', message: '状态未知', pendingImage: image })
assert.equal(caseIResult.status, 'start-acceptance-unknown')
assert.equal(caseIResult.state.stage, SUBMISSION_STAGE.START_ACCEPTANCE_UNKNOWN)
assert.equal(caseIResult.state.uploadedAttachment, uploadedAttachment)
assert.equal(caseIResult.state.pendingImage, image)
assert.equal(caseI.visibleUserCount, 1)
assert.equal(caseI.restored.length, 0)
assert.equal(caseI.startAcceptanceUnknown.length, 1)
assert.equal(caseI.controller.hasActive(), true)
assert.equal(caseI.controller.getActiveTurnId(), null)
assert.equal(caseI.uploadCount, 1)
const caseIStartCount = caseI.startCount
const caseJResult = await caseI.controller.submit({ draftText: '状态未知', message: '状态未知', pendingImage: image })
assert.equal(caseJResult.status, 'busy')
assert.equal(caseI.startCount, caseIStartCount)
assert.equal(caseI.uploadCount, 1)

// CASE K: a transient accepted poll failure is retried with the same turn and
// saved cursor, even while the browser remains online. The retry never starts
// a second turn.
let caseKRetryArguments = null
const caseK = createHarness({
  runs: [
    async ({ onTurnAccepted, onPollProgress }) => {
      onTurnAccepted('turn-k')
      onPollProgress({ after: 7, presentation: {}, assistantRendered: true })
      const error = networkFailure('temporary poll loss')
      error.turnPollTransient = true
      throw error
    },
    async (args) => {
      caseKRetryArguments = args
      assert.equal(args.turnId, 'turn-k')
      assert.equal(args.after, 7)
      args.onPollProgress({ after: 8, presentation: {}, assistantRendered: true })
      return { stage: SUBMISSION_STAGE.TURN_COMPLETED, turnId: args.turnId, after: 8 }
    },
  ],
})
const caseKResult = await caseK.controller.submit({ draftText: '短暂断线', message: '短暂断线', pendingImage: null })
assert.equal(caseKResult.status, 'completed')
assert.deepEqual(caseK.retryDelays, [1_000])
assert.equal(caseK.pollRetries.length, 1)
assert.equal(caseKRetryArguments.turnId, 'turn-k')
assert.equal(caseKRetryArguments.after, 7)
assert.equal(caseK.startCount, 1)
assert.equal(caseK.runCount, 2)
assert.equal(caseK.visibleUserCount, 1)

// CASE L: bounded retries may succeed without changing turn ownership. The
// owner bubble remains singular throughout the automatic retry sequence.
const caseLArguments = []
const caseL = createHarness({
  runs: [
    async ({ onTurnAccepted, onPollProgress }) => {
      onTurnAccepted('turn-l')
      onPollProgress({ after: 10, presentation: {}, assistantRendered: true })
      const error = networkFailure('first transient poll loss')
      error.turnPollTransient = true
      throw error
    },
    async (args) => {
      caseLArguments.push(args)
      assert.equal(args.turnId, 'turn-l')
      assert.equal(args.after, 10)
      const error = networkFailure('second transient poll loss')
      error.turnPollTransient = true
      throw error
    },
    async (args) => {
      caseLArguments.push(args)
      assert.equal(args.turnId, 'turn-l')
      assert.equal(args.after, 10)
      args.onPollProgress({ after: 11, presentation: {}, assistantRendered: true })
      return { stage: SUBMISSION_STAGE.TURN_COMPLETED, turnId: args.turnId, after: 11 }
    },
  ],
})
const caseLResult = await caseL.controller.submit({ draftText: '稍后完成', message: '稍后完成', pendingImage: null })
assert.equal(caseLResult.status, 'completed')
assert.deepEqual(caseL.retryDelays, [1_000, 2_000])
assert.equal(caseL.startCount, 1)
assert.equal(caseL.runCount, 3)
assert.equal(caseLArguments[0].turnId, 'turn-l')
assert.equal(caseLArguments[1].turnId, 'turn-l')
assert.equal(caseLArguments[0].after, 10)
assert.equal(caseLArguments[1].after, 10)
assert.equal(caseL.visibleUserCount, 1)

// CASE M: after the bounded retry budget is exhausted, the turn is paused and
// only an explicit same-turn resume may continue it.
const caseM = createHarness({
  runs: [
    async ({ onTurnAccepted, onPollProgress }) => {
      onTurnAccepted('turn-m')
      onPollProgress({ after: 20, presentation: {}, assistantRendered: true })
      const error = networkFailure('transient poll loss 0')
      error.turnPollTransient = true
      throw error
    },
    async (args) => {
      assert.equal(args.turnId, 'turn-m')
      assert.equal(args.after, 20)
      const error = networkFailure('transient poll loss 1')
      error.turnPollTransient = true
      throw error
    },
    async (args) => {
      assert.equal(args.turnId, 'turn-m')
      assert.equal(args.after, 20)
      const error = networkFailure('transient poll loss 2')
      error.turnPollTransient = true
      throw error
    },
    async (args) => {
      assert.equal(args.turnId, 'turn-m')
      assert.equal(args.after, 20)
      const error = networkFailure('transient poll loss 3')
      error.turnPollTransient = true
      throw error
    },
    completedRun('turn-m'),
  ],
})
const caseMResult = await caseM.controller.submit({ draftText: '需要继续等待', message: '需要继续等待', pendingImage: null })
assert.equal(caseMResult.status, 'accepted-failure')
assert.equal(caseMResult.state.stage, SUBMISSION_STAGE.TURN_ACCEPTED)
assert.equal(caseMResult.state.paused, true)
assert.equal(caseM.controller.getActiveTurnId(), 'turn-m')
assert.deepEqual(caseM.retryDelays, [1_000, 2_000, 4_000])
assert.equal(caseM.startCount, 1)
assert.equal(caseM.runCount, 4)
assert.equal(caseM.visibleUserCount, 1)
const caseMPausedResume = await caseM.controller.resume()
assert.equal(caseMPausedResume.status, 'paused')
assert.equal(caseM.runCount, 4)
const caseMStartCount = caseM.startCount
const caseMExplicitResume = await caseM.controller.resume({ explicit: true })
assert.equal(caseMExplicitResume.status, 'completed')
assert.equal(caseMExplicitResume.state.turnId, 'turn-m')
assert.equal(caseM.startCount, caseMStartCount)
assert.equal(caseM.controller.hasActive(), false)

// CASE H: the existing composer acceptance surface remains wired to the same
// frontend path; behavioral autosize/Plus/Send/IME/Emoji coverage runs in the
// existing v0.4-mobile-composer-polish fixture.
assert.match(indexHtml, /submission-state\.js/u)
assert.match(mobileJs, /TURN_ACCEPTED/u)
assert.match(mobileJs, /onTurnAccepted/u)
assert.match(mobileJs, /onStartInFlight/u)
assert.match(mobileJs, /START_ACCEPTANCE_UNKNOWN/u)
assert.match(mobileJs, /消息可能已经交给花花了，正在确认/u)
assert.match(mobileJs, /submission-resume-button/u)
assert.match(submissionJs, /POLL_RETRY_DELAYS_MS/u)
assert.match(mobileJs, /markStartFailure/u)
assert.match(mobileJs, /markPollTransportFailure/u)
assert.match(mobileJs, /activeTurnId/u)
assert.match(mobileJs, /restoreImageSelection\(state\.pendingImage\)/u)
assert.match(mobileJs, /isBusy: \(\) => imageProcessing \|\| Boolean\(submissionController\?\.hasActive\?\.\(\)\)/u)

console.log('CASE_A_PRE_UPLOAD_ROLLBACK=PASS')
console.log('CASE_B_UPLOADED_CACHE_RETRY=PASS')
console.log('CASE_C_ACCEPTED_SAME_TURN_RESUME=PASS')
console.log('CASE_D_SERVER_TURN_FAILED_NO_AUTO_RETRY=PASS')
console.log('CASE_E_PRE_ACCEPT_RETRY_ONE_VISIBLE_USER=PASS')
console.log('CASE_F_IMAGE_UPLOAD_ONCE_ID_UNCHANGED=PASS')
console.log('CASE_G_TEXT_IMAGE_SUCCESS=PASS')
console.log('CASE_I_START_RESPONSE_LOST_FAIL_CLOSED=PASS')
console.log('CASE_J_UNKNOWN_ORDINARY_SUBMIT_NO_NEW_START=PASS')
console.log('CASE_K_ACCEPTED_POLL_BOUNDED_SAME_TURN=PASS')
console.log('CASE_L_BOUNDED_RETRY_EVENTUAL_COMPLETION=PASS')
console.log('CASE_M_BOUNDED_RETRY_EXHAUSTED_EXPLICIT_RESUME=PASS')
console.log('CASE_H_EXISTING_COMPOSER_CONTRACT=PASS')
console.log('SUBMISSION_STAGES=PRE_UPLOAD|PRE_START|UPLOADED|START_IN_FLIGHT|START_ACCEPTANCE_UNKNOWN|TURN_ACCEPTED|TURN_COMPLETED|TURN_FAILED')
console.log('ACCEPTED_POLL_RETRY_DELAYS_MS=1000|2000|4000')
console.log('ACCEPTED_POLL_RETRY_START_COUNT=0')
console.log('EXPLICIT_RESUME_SAME_TURN=PASS')
console.log('ATTACHMENT_UPLOAD_COUNT_ON_FAILURE_RETRY=1')
console.log('ATTACHMENT_REUSED=YES')
console.log('START_UNKNOWN_AUTO_RESEND=NO')
console.log('START_UNKNOWN_DRAFT_RESTORED=NO')
console.log('AUTOMATIC_DUPLICATE_TURN=NO')
