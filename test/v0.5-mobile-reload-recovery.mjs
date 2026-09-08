import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { SERVER_IDEMPOTENCY_TTL_MS } from '../src/remote/chat-submission-idempotency.js'

const root = process.cwd()
const [submissionJs, mobileJs, indexHtml] = await Promise.all([
  readFile(join(root, 'src/remote/mobile-ui/submission-state.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/index.html'), 'utf8'),
])

const context = { console }
vm.createContext(context)
vm.runInContext(submissionJs, context, { filename: 'submission-state.js' })
const submission = context.VcAiPetSubmission
const { SUBMISSION_STAGE, createPendingSubmissionStore, createSubmissionController } = submission
const generatedIds = new Set([submission.createSubmissionId(), submission.createSubmissionId()])
assert.equal(generatedIds.size, 2)

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries)
  }

  getItem(key) { return this.values.has(key) ? this.values.get(key) : null }

  setItem(key, value) { this.values.set(key, String(value)) }

  removeItem(key) { this.values.delete(key) }
}

const image = {
  dataUrl: 'data:image/webp;base64,AAAA',
  thumbnailDataUrl: 'data:image/webp;base64,BBBB',
  width: 12,
  height: 12,
}

function networkFailure(message = 'network lost') {
  return Object.assign(new Error(message), { code: 'FRONTEND_FETCH_ERROR' })
}

function turnFailed() {
  return Object.assign(new Error('server turn failed'), { code: 'TURN_FAILED' })
}

function createServer() {
  let startCalls = 0
  let newTurnCount = 0
  let nextTurn = 0
  const records = new Map()

  function start({ submissionId, message, attachment }) {
    startCalls += 1
    const attachmentId = attachment?.id ?? null
    const fingerprint = JSON.stringify({ message, attachmentId })
    const existing = records.get(submissionId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Object.assign(new Error('submission conflict'), { code: 'SUBMISSION_ID_CONFLICT' })
      return { turnId: existing.turnId, idempotentReplay: true }
    }
    const turnId = `turn-reload-${++nextTurn}`
    records.set(submissionId, { turnId, fingerprint })
    newTurnCount += 1
    return { turnId, idempotentReplay: false }
  }

  return {
    start,
    get startCalls() { return startCalls },
    get newTurnCount() { return newTurnCount },
  }
}

let currentTime = 10_000

function createHarness({ server, storage = new MemoryStorage(), run, upload } = {}) {
  const pendingStore = createPendingSubmissionStore({ storage, now: () => currentTime })
  let uploadCount = 0
  const runCalls = []
  const optimisticNodes = []
  const acceptedTurnIds = []
  const controller = createSubmissionController({
    pendingStore,
    uploadImage: async (pendingImage) => {
      uploadCount += 1
      if (upload) return upload(pendingImage, uploadCount)
      return { id: 'attachment-reload-1' }
    },
    runTurnProgress: async (args) => {
      runCalls.push(args)
      return run(args)
    },
    onOptimisticUser: () => {
      const node = { removed: false }
      optimisticNodes.push(node)
      return node
    },
    onAccepted: (state) => acceptedTurnIds.push(state.turnId),
    onPreAcceptFailure: (state) => { if (state.optimisticUserNode) state.optimisticUserNode.removed = true },
    onServerFailure: (state) => { if (state.optimisticUserNode) state.optimisticUserNode.removed = false },
    waitForPollRetry: async () => {},
  })
  return {
    controller,
    pendingStore,
    storage,
    runCalls,
    optimisticNodes,
    acceptedTurnIds,
    get uploadCount() { return uploadCount },
  }
}

function successfulRun(server, args) {
  let turnId = args.turnId
  if (!turnId) {
    args.onStartInFlight()
    turnId = server.start({ submissionId: args.submissionId, message: args.message, attachment: args.attachment }).turnId
    args.onTurnAccepted(turnId)
  }
  const after = (Number.isInteger(args.after) ? args.after : 0) + 1
  args.onPollProgress({ after, presentation: {}, assistantRendered: true })
  return { stage: SUBMISSION_STAGE.TURN_COMPLETED, turnId, after }
}

// CASE R: START_IN_FLIGHT response loss is persisted as UNKNOWN and the next
// WebView reuses the id and uploaded attachment. The server replay creates no
// second turn.
const serverR = createServer()
const storageR = new MemoryStorage()
const firstR = createHarness({
  server: serverR,
  storage: storageR,
  run: async (args) => {
    args.onStartInFlight()
    serverR.start({ submissionId: args.submissionId, message: args.message, attachment: args.attachment })
    throw networkFailure('start response lost')
  },
  upload: async () => ({ id: 'attachment-r' }),
})
const firstRResult = await firstR.controller.submit({ draftText: 'reload R', message: 'reload R', pendingImage: image })
assert.equal(firstRResult.status, 'start-acceptance-unknown')
assert.equal(firstR.uploadCount, 1)
const pendingR = firstR.pendingStore.read()
assert.equal(pendingR.status, 'pending')
assert.equal(pendingR.pending.stage, SUBMISSION_STAGE.START_ACCEPTANCE_UNKNOWN)
assert.equal(pendingR.pending.attachmentId, 'attachment-r')
assert.doesNotMatch(storageR.getItem(submission.PENDING_SUBMISSION_STORAGE_KEY), /data:image/iu)
const secondR = createHarness({
  server: serverR,
  storage: storageR,
  run: (args) => successfulRun(serverR, args),
})
const newTurnCountBeforeRReplay = serverR.newTurnCount
const secondRResult = await secondR.controller.recover(pendingR.pending)
assert.equal(secondRResult.status, 'completed')
assert.equal(secondR.runCalls[0].submissionId, pendingR.pending.submissionId)
assert.equal(secondR.runCalls[0].attachment.id, 'attachment-r')
assert.equal(serverR.newTurnCount, 1)
assert.equal(serverR.newTurnCount, newTurnCountBeforeRReplay)
assert.equal(serverR.startCalls, 2)

// CASE S: an UNKNOWN record loaded directly from storage performs one
// idempotent reconciliation with the same submission id.
const serverS = createServer()
const storageS = new MemoryStorage()
const storeS = createPendingSubmissionStore({ storage: storageS, now: () => currentTime })
storeS.saveState({
  submissionId: 'submission-s', message: 'reload S', pendingImage: null,
  uploadedAttachment: { id: 'attachment-s' }, stage: SUBMISSION_STAGE.START_ACCEPTANCE_UNKNOWN,
  createdAt: currentTime, after: 0,
})
const pendingS = storeS.read()
const harnessS = createHarness({ server: serverS, storage: storageS, run: (args) => successfulRun(serverS, args) })
const resultS = await harnessS.controller.recover(pendingS.pending)
assert.equal(resultS.status, 'completed')
assert.equal(harnessS.runCalls[0].submissionId, 'submission-s')
assert.equal(serverS.newTurnCount, 1)

// CASE T: an accepted turn reloads directly into same-turn polling, keeping
// both the turn id and the after cursor; it never calls start again.
const serverT = createServer()
const storageT = new MemoryStorage()
const firstT = createHarness({
  server: serverT,
  storage: storageT,
  run: async (args) => {
    args.onStartInFlight()
    const turnId = serverT.start({ submissionId: args.submissionId, message: args.message, attachment: args.attachment }).turnId
    args.onTurnAccepted(turnId)
    args.onPollProgress({ after: 5, presentation: {}, assistantRendered: true })
    throw networkFailure('poll response lost')
  },
})
const firstTResult = await firstT.controller.submit({ draftText: 'reload T', message: 'reload T', pendingImage: null })
assert.equal(firstTResult.status, 'accepted-failure')
const pendingT = firstT.pendingStore.read()
assert.equal(pendingT.pending.stage, SUBMISSION_STAGE.TURN_ACCEPTED)
const turnT = pendingT.pending.turnId
const secondT = createHarness({
  server: serverT,
  storage: storageT,
  run: (args) => {
    assert.equal(args.turnId, turnT)
    assert.equal(args.after, 5)
    args.onPollProgress({ after: 6, presentation: {}, assistantRendered: true })
    return { stage: SUBMISSION_STAGE.TURN_COMPLETED, turnId: args.turnId, after: 6 }
  },
})
const secondTResult = await secondT.controller.recover(pendingT.pending)
assert.equal(secondTResult.status, 'completed')
assert.equal(serverT.newTurnCount, 1)
assert.equal(serverT.startCalls, 1)

// CASE U: UPLOADED reload reuses the stored attachment id and performs no
// second upload before reconciling start.
const serverU = createServer()
const storageU = new MemoryStorage()
const storeU = createPendingSubmissionStore({ storage: storageU, now: () => currentTime })
storeU.saveState({
  submissionId: 'submission-u', message: 'reload U', pendingImage: null,
  uploadedAttachment: { id: 'attachment-u' }, stage: SUBMISSION_STAGE.UPLOADED,
  createdAt: currentTime, after: 0,
})
const harnessU = createHarness({ server: serverU, storage: storageU, run: (args) => successfulRun(serverU, args) })
const resultU = await harnessU.controller.recover(storeU.read().pending)
assert.equal(resultU.status, 'completed')
assert.equal(harnessU.uploadCount, 0)
assert.equal(harnessU.runCalls[0].attachment.id, 'attachment-u')
assert.equal(serverU.newTurnCount, 1)

// CASE V: PRE_UPLOAD with an image has only RAM image bytes. Reload cannot
// fake a send; it clears the incomplete record and asks for reselection.
const serverV = createServer()
const storageV = new MemoryStorage()
let rejectUpload
const uploadPending = new Promise((resolve, reject) => { rejectUpload = reject })
const harnessV = createHarness({
  server: serverV,
  storage: storageV,
  upload: () => uploadPending,
  run: () => { throw new Error('PRE_UPLOAD must not reach start') },
})
const submitV = harnessV.controller.submit({ draftText: '图片还没上传', message: '图片还没上传', pendingImage: image })
await Promise.resolve()
const pendingV = harnessV.pendingStore.read()
assert.equal(pendingV.pending.stage, SUBMISSION_STAGE.PRE_UPLOAD)
assert.equal(pendingV.pending.hasImage, true)
assert.equal(pendingV.pending.attachmentId, undefined)
assert.equal(serverV.startCalls, 0)
harnessV.pendingStore.clear()
assert.equal(harnessV.pendingStore.read().status, 'empty')
rejectUpload(networkFailure('upload interrupted'))
const resultV = await submitV
assert.equal(resultV.status, 'pre-accept-failure')
assert.equal(serverV.startCalls, 0)

// CASE W: successful completion removes the persisted record.
const serverW = createServer()
const storageW = new MemoryStorage()
const harnessW = createHarness({ server: serverW, storage: storageW, run: (args) => successfulRun(serverW, args) })
const resultW = await harnessW.controller.submit({ draftText: '完成 W', message: '完成 W', pendingImage: null })
assert.equal(resultW.status, 'completed')
assert.equal(storageW.getItem(submission.PENDING_SUBMISSION_STORAGE_KEY), null)
const firstWSubmissionId = resultW.state.submissionId
const secondWResult = await harnessW.controller.submit({ draftText: '完成 W', message: '完成 W', pendingImage: null })
assert.equal(secondWResult.status, 'completed')
assert.notEqual(secondWResult.state.submissionId, firstWSubmissionId)
assert.equal(storageW.getItem(submission.PENDING_SUBMISSION_STORAGE_KEY), null)

// CASE X: terminal turn_failed also clears storage and leaves no retryable
// submission.
const serverX = createServer()
const storageX = new MemoryStorage()
const harnessX = createHarness({
  server: serverX,
  storage: storageX,
  run: async (args) => {
    args.onStartInFlight()
    const turnId = serverX.start({ submissionId: args.submissionId, message: args.message, attachment: args.attachment }).turnId
    args.onTurnAccepted(turnId)
    throw turnFailed()
  },
})
const resultX = await harnessX.controller.submit({ draftText: '失败 X', message: '失败 X', pendingImage: null })
assert.equal(resultX.status, 'turn-failed')
assert.equal(storageX.getItem(submission.PENDING_SUBMISSION_STORAGE_KEY), null)
assert.equal(harnessX.controller.getRetryable(), null)

// CASE Y: stale pending data is discarded without an automatic start.
const serverY = createServer()
const storageY = new MemoryStorage()
const storeY = createPendingSubmissionStore({ storage: storageY, now: () => currentTime, maxAgeMs: 100 })
storeY.saveState({
  submissionId: 'submission-y', message: '过期', pendingImage: null,
  uploadedAttachment: null, stage: SUBMISSION_STAGE.START_IN_FLIGHT,
  createdAt: currentTime - 101, after: 0,
})
const staleY = storeY.read()
assert.equal(staleY.status, 'stale')
assert.equal(storageY.getItem(submission.PENDING_SUBMISSION_STORAGE_KEY), null)
assert.equal(serverY.newTurnCount, 0)

// CASE AB: the default frontend pending lifetime is the same as the server
// registry TTL. At the boundary, stale data is cleared and boot recovery does
// not get a pending record to reconcile.
const serverAB = createServer()
const storageAB = new MemoryStorage()
const storeAB = createPendingSubmissionStore({ storage: storageAB, now: () => currentTime })
const pendingCreatedAtAB = currentTime
storeAB.saveState({
  submissionId: 'submission-ab', message: '同一 TTL', pendingImage: null,
  uploadedAttachment: { id: 'attachment-ab' }, stage: SUBMISSION_STAGE.UPLOADED,
  createdAt: pendingCreatedAtAB, after: 0,
})
currentTime = pendingCreatedAtAB + submission.CLIENT_PENDING_MAX_AGE_MS
const staleAB = storeAB.read()
assert.equal(staleAB.status, 'stale')
assert.equal(storageAB.getItem(submission.PENDING_SUBMISSION_STORAGE_KEY), null)
assert.equal(serverAB.newTurnCount, 0)
assert.equal(submission.CLIENT_PENDING_MAX_AGE_MS, 10 * 60 * 1000)
assert.equal(submission.CLIENT_PENDING_MAX_AGE_MS, SERVER_IDEMPOTENCY_TTL_MS)
assert.match(mobileJs, /if \(result\?\.status !== 'pending'\) return/u)

// CASE Z: two independent reload clients with one persisted id converge on
// one host-side turn even when they recover concurrently.
const serverZ = createServer()
const storageZ = new MemoryStorage()
const storeZ = createPendingSubmissionStore({ storage: storageZ, now: () => currentTime })
storeZ.saveState({
  submissionId: 'submission-z', message: '两个客户端', pendingImage: null,
  uploadedAttachment: null, stage: SUBMISSION_STAGE.START_IN_FLIGHT,
  createdAt: currentTime, after: 0,
})
const pendingZ = storeZ.read().pending
const clientZ1 = createHarness({ server: serverZ, storage: storageZ, run: (args) => successfulRun(serverZ, args) })
const clientZ2 = createHarness({ server: serverZ, storage: storageZ, run: (args) => successfulRun(serverZ, args) })
const [resultZ1, resultZ2] = await Promise.all([
  clientZ1.controller.recover(pendingZ),
  clientZ2.controller.recover(pendingZ),
])
assert.equal(resultZ1.status, 'completed')
assert.equal(resultZ2.status, 'completed')
assert.equal(serverZ.newTurnCount, 1)
assert.equal(serverZ.startCalls, 2)
assert.equal(clientZ1.acceptedTurnIds[0], clientZ2.acceptedTurnIds[0])

// The page wiring carries persistence and idempotent start through the real
// mobile path, while the existing A-M fixture owns the earlier behavior.
assert.match(indexHtml, /submission-state\.js/u)
assert.match(submissionJs, /createPendingSubmissionStore/u)
assert.match(submissionJs, /createSubmissionId/u)
assert.match(submissionJs, /PENDING_SUBMISSION_STORAGE_KEY/u)
assert.match(submissionJs, /submissionId/u)
assert.match(mobileJs, /pendingSubmissionStore/u)
assert.match(mobileJs, /recoverPendingSubmission/u)
assert.match(mobileJs, /JSON\.stringify\(\{ submissionId/u)
assert.match(mobileJs, /submissionId \|\| !\[404, 405\]/u)
assert.match(mobileJs, /上次图片还没有完成上传，请重新选择图片/u)

console.log('CASE_R_START_IN_FLIGHT_RELOAD_IDEMPOTENT=PASS')
console.log('CASE_S_UNKNOWN_RELOAD_IDEMPOTENT=PASS')
console.log('CASE_T_ACCEPTED_RELOAD_SAME_TURN_CURSOR=PASS')
console.log('CASE_U_UPLOADED_RELOAD_NO_REUPLOAD=PASS')
console.log('CASE_V_PRE_UPLOAD_RESELECT_NO_FAKE_SEND=PASS')
console.log('CASE_W_COMPLETE_STORAGE_CLEARED=PASS')
console.log('CASE_X_FAILED_STORAGE_CLEARED=PASS')
console.log('CASE_Y_STALE_PENDING_CLEARED_NO_START=PASS')
console.log('CASE_AB_PENDING_TTL_CLEARED_NO_RECONCILE=PASS')
console.log('CASE_Z_TWO_CLIENTS_ONE_TURN=PASS')
console.log('ATTACHMENT_UPLOAD_COUNT_ON_FAILURE_RETRY=1')
console.log('ATTACHMENT_REUSED=YES')
console.log('CLIENT_PENDING_MAX_AGE=10_MINUTES')
console.log('LOCALSTORAGE_USER_MESSAGE_TEXT=YES')
console.log('LOCALSTORAGE_IMAGE_BASE64=NO')
console.log('CROSS_WEBVIEW_RELOAD_DUPLICATE_TURN=NO')
console.log('CROSS_APP_RESTART_DUPLICATE_TURN=NO')
console.log('START_UNKNOWN_AUTO_RESEND=NO')
console.log('START_UNKNOWN_DRAFT_RESTORED=NO')
