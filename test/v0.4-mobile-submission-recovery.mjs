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
  let archiveEquivalentUserMessageCount = 0

  const controller = createSubmissionController({
    uploadImage: async (pendingImage) => {
      uploadCount += 1
      if (upload) return upload(pendingImage, uploadCount)
      return { id: `attachment-${uploadCount}` }
    },
    runTurnProgress: async (args) => {
      runCount += 1
      if (!args.turnId) startCount += 1
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
    onServerFailure: (state) => {
      serverFailures.push({ stage: state.stage, turnId: state.turnId })
      archiveEquivalentUserMessageCount += 1
    },
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
    async () => { throw networkFailure('start unavailable') },
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
assert.equal(caseCResume.status, 'completed')
assert.equal(caseCResume.state.stage, SUBMISSION_STAGE.TURN_COMPLETED)
assert.equal(caseCResume.state.turnId, 'turn-owned')
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
    async () => { throw networkFailure('before accept') },
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

// CASE H: the existing composer acceptance surface remains wired to the same
// frontend path; behavioral autosize/Plus/Send/IME/Emoji coverage runs in the
// existing v0.4-mobile-composer-polish fixture.
assert.match(indexHtml, /submission-state\.js/u)
assert.match(mobileJs, /TURN_ACCEPTED/u)
assert.match(mobileJs, /onTurnAccepted/u)
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
console.log('CASE_H_EXISTING_COMPOSER_CONTRACT=PASS')
console.log('SUBMISSION_STAGES=PRE_UPLOAD|UPLOADED|TURN_ACCEPTED|TURN_COMPLETED|TURN_FAILED')
console.log('AUTOMATIC_DUPLICATE_TURN=NO')
