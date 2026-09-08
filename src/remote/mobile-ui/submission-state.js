(() => {
  const SUBMISSION_STAGE = Object.freeze({
    PRE_UPLOAD: 'PRE_UPLOAD',
    PRE_START: 'PRE_START',
    UPLOADED: 'UPLOADED',
    START_IN_FLIGHT: 'START_IN_FLIGHT',
    START_ACCEPTANCE_UNKNOWN: 'START_ACCEPTANCE_UNKNOWN',
    TURN_ACCEPTED: 'TURN_ACCEPTED',
    TURN_COMPLETED: 'TURN_COMPLETED',
    TURN_FAILED: 'TURN_FAILED',
  })
  const POLL_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000])
  const SUBMISSION_ID_PATTERN = /^[a-z0-9_-]{1,80}$/iu
  const PENDING_SUBMISSION_STORAGE_KEY = 'vc-ai-pet.pending-submission.v1'
  const PENDING_SUBMISSION_SCHEMA_VERSION = 1
  const CLIENT_PENDING_MAX_AGE_MS = 10 * 60 * 1_000
  const PENDING_SUBMISSION_MAX_AGE_MS = CLIENT_PENDING_MAX_AGE_MS
  const PERSISTED_STAGES = new Set([
    SUBMISSION_STAGE.PRE_UPLOAD,
    SUBMISSION_STAGE.PRE_START,
    SUBMISSION_STAGE.UPLOADED,
    SUBMISSION_STAGE.START_IN_FLIGHT,
    SUBMISSION_STAGE.START_ACCEPTANCE_UNKNOWN,
    SUBMISSION_STAGE.TURN_ACCEPTED,
    SUBMISSION_STAGE.TURN_COMPLETED,
    SUBMISSION_STAGE.TURN_FAILED,
  ])
  let submissionSequence = 0

  function isSubmissionId(value) {
    return typeof value === 'string' && SUBMISSION_ID_PATTERN.test(value)
  }

  function createSubmissionId() {
    try {
      if (typeof globalThis.crypto?.randomUUID === 'function') {
        const id = globalThis.crypto.randomUUID()
        if (isSubmissionId(id)) return id
      }
    } catch {
      // Some embedded WebViews expose crypto without randomUUID.
    }
    let random = ''
    try {
      if (typeof globalThis.crypto?.getRandomValues === 'function') {
        const values = new Uint32Array(2)
        globalThis.crypto.getRandomValues(values)
        random = Array.from(values, (value) => value.toString(36)).join('')
      }
    } catch {
      // Use the time/counter fallback below when secure randomness is absent.
    }
    if (!random) random = Math.random().toString(36).slice(2)
    submissionSequence += 1
    return `s-${Date.now().toString(36)}-${random}-${submissionSequence.toString(36)}`.slice(0, 80)
  }

  function defaultStorage() {
    try {
      return globalThis.localStorage ?? null
    } catch {
      return null
    }
  }

  function normalizePersistedStage(stage) {
    if (stage === SUBMISSION_STAGE.PRE_START) return SUBMISSION_STAGE.START_IN_FLIGHT
    return stage
  }

  function createPendingSubmissionStore({ storage = undefined, now = () => Date.now(), maxAgeMs = PENDING_SUBMISSION_MAX_AGE_MS } = {}) {
    const target = storage === undefined ? defaultStorage() : storage

    function clear() {
      try { target?.removeItem?.(PENDING_SUBMISSION_STORAGE_KEY) } catch { /* storage can be unavailable in an embedded WebView */ }
    }

    function recordFor(state = {}) {
      const attachmentId = typeof state.uploadedAttachment?.id === 'string' ? state.uploadedAttachment.id : null
      const stage = state.stage === SUBMISSION_STAGE.PRE_START
        ? SUBMISSION_STAGE.START_IN_FLIGHT
        : state.stage
      if (!isSubmissionId(state.submissionId) || typeof state.message !== 'string' || !PERSISTED_STAGES.has(stage)) return null
      const createdAt = Number(state.createdAt)
      if (!Number.isInteger(createdAt) || createdAt < 0) return null
      return {
        schemaVersion: PENDING_SUBMISSION_SCHEMA_VERSION,
        submissionId: state.submissionId,
        message: state.message,
        ...(attachmentId ? { attachmentId } : {}),
        stage,
        ...(typeof state.turnId === 'string' && state.turnId ? { turnId: state.turnId } : {}),
        after: Number.isInteger(state.after) && state.after >= 0 ? state.after : 0,
        createdAt,
        hasImage: Boolean(state.pendingImage || attachmentId),
      }
    }

    function saveState(state) {
      const record = recordFor(state)
      if (!record || !target?.setItem) return record
      try {
        target.setItem(PENDING_SUBMISSION_STORAGE_KEY, JSON.stringify(record))
      } catch {
        // A private-mode or quota-restricted WebView must not break sending.
      }
      return record
    }

    function read() {
      let raw
      try { raw = target?.getItem?.(PENDING_SUBMISSION_STORAGE_KEY) } catch { raw = null }
      if (!raw) return { status: 'empty', pending: null }

      let record
      try { record = JSON.parse(raw) } catch {
        clear()
        return { status: 'invalid', pending: null }
      }
      const stage = normalizePersistedStage(record?.stage)
      const createdAt = Number(record?.createdAt)
      const after = Number(record?.after ?? 0)
      const attachmentId = record?.attachmentId
      const valid = record?.schemaVersion === PENDING_SUBMISSION_SCHEMA_VERSION
        && isSubmissionId(record?.submissionId)
        && typeof record?.message === 'string'
        && PERSISTED_STAGES.has(stage)
        && Number.isInteger(createdAt)
        && createdAt >= 0
        && Number.isInteger(after)
        && after >= 0
        && (attachmentId === undefined || (typeof attachmentId === 'string' && isSubmissionId(attachmentId)))
        && (stage !== SUBMISSION_STAGE.TURN_ACCEPTED || (typeof record?.turnId === 'string' && record.turnId.length > 0))
        && (record?.message.length > 0 || record?.hasImage === true || typeof attachmentId === 'string')
      if (!valid) {
        clear()
        return { status: 'invalid', pending: null }
      }
      if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now() - createdAt >= maxAgeMs) {
        clear()
        return { status: 'stale', pending: null, createdAt }
      }
      if ([SUBMISSION_STAGE.TURN_COMPLETED, SUBMISSION_STAGE.TURN_FAILED].includes(stage)) {
        clear()
        return { status: 'terminal', pending: null, stage }
      }
      return {
        status: 'pending',
        pending: {
          schemaVersion: PENDING_SUBMISSION_SCHEMA_VERSION,
          submissionId: record.submissionId,
          message: record.message,
          ...(typeof attachmentId === 'string' ? { attachmentId } : {}),
          stage,
          ...(typeof record.turnId === 'string' && record.turnId ? { turnId: record.turnId } : {}),
          after,
          createdAt,
          hasImage: record.hasImage === true || typeof attachmentId === 'string',
        },
      }
    }

    return Object.freeze({
      key: PENDING_SUBMISSION_STORAGE_KEY,
      schemaVersion: PENDING_SUBMISSION_SCHEMA_VERSION,
      maxAgeMs,
      saveState,
      read,
      clear,
    })
  }

  function createSubmissionController({
    uploadImage,
    runTurnProgress,
    pendingStore = null,
    onOptimisticUser,
    onAccepted,
    onCompleted,
    onPreAcceptFailure,
    onAcceptedFailure,
    onServerFailure,
    onStartAcceptanceUnknown,
    onPollRetry,
    onResume,
    waitForPollRetry = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {}) {
    let activeSubmission = null
    let retryableSubmission = null
    let resumePromise = null
    let executionPromise = null

    function persist(state) {
      try { pendingStore?.saveState?.(state) } catch { /* persistence is best effort and never changes transport state */ }
    }

    function clearPersisted() {
      try { pendingStore?.clear?.() } catch { /* an unavailable store must not alter recovery semantics */ }
    }

    function matchesRetryable({ draftText, message, pendingImage } = {}) {
      return Boolean(
        retryableSubmission
        && retryableSubmission.draftText === draftText
        && retryableSubmission.message === message
        && retryableSubmission.pendingImage === pendingImage,
      )
    }

    function createState({ draftText, message, pendingImage, uploadedAttachment = null, submissionId = createSubmissionId(), createdAt = Date.now(), stage = null } = {}) {
      return {
        stage: stage ?? (pendingImage ? SUBMISSION_STAGE.PRE_UPLOAD : SUBMISSION_STAGE.PRE_START),
        draftText,
        message,
        pendingImage,
        uploadedAttachment,
        submissionId,
        createdAt,
        turnId: null,
        after: 0,
        presentation: null,
        assistantRendered: false,
        pollRetryCount: 0,
        paused: false,
        optimisticUserNode: null,
        thinkingMessage: null,
      }
    }

    function recover(pending = {}) {
      if (activeSubmission) return Promise.resolve({ status: 'busy', state: activeSubmission })
      const stage = normalizePersistedStage(pending.stage)
      if (!isSubmissionId(pending.submissionId) || typeof pending.message !== 'string' || !PERSISTED_STAGES.has(stage)) {
        return Promise.resolve({ status: 'invalid-recovery', state: null })
      }
      if (stage === SUBMISSION_STAGE.PRE_UPLOAD) {
        return Promise.resolve({ status: 'pre-upload-recovery-required', state: null })
      }
      if ([SUBMISSION_STAGE.TURN_COMPLETED, SUBMISSION_STAGE.TURN_FAILED].includes(stage)) {
        return Promise.resolve({ status: 'terminal-recovery', state: null })
      }
      if (stage === SUBMISSION_STAGE.TURN_ACCEPTED && (typeof pending.turnId !== 'string' || !pending.turnId)) {
        return Promise.resolve({ status: 'invalid-recovery', state: null })
      }
      const uploadedAttachment = typeof pending.attachmentId === 'string' ? { id: pending.attachmentId } : null
      const state = createState({
        draftText: '',
        message: pending.message,
        pendingImage: null,
        uploadedAttachment,
        submissionId: pending.submissionId,
        createdAt: pending.createdAt,
        stage,
      })
      state.turnId = typeof pending.turnId === 'string' ? pending.turnId : null
      state.after = Number.isInteger(pending.after) && pending.after >= 0 ? pending.after : 0
      activeSubmission = state
      retryableSubmission = null
      persist(state)
      state.optimisticUserNode = onOptimisticUser?.(state) ?? null
      return startExecution(state)
    }

    async function execute(state) {
      let result
      try {
        let attachment = state.uploadedAttachment
        if (state.pendingImage && !attachment) {
          state.stage = SUBMISSION_STAGE.PRE_UPLOAD
          persist(state)
          attachment = await uploadImage(state.pendingImage)
          state.uploadedAttachment = attachment
          state.stage = SUBMISSION_STAGE.UPLOADED
          persist(state)
        } else if (!state.turnId && attachment) {
          state.stage = SUBMISSION_STAGE.UPLOADED
          persist(state)
        }
        if (!state.turnId) {
          state.stage = SUBMISSION_STAGE.PRE_START
          persist(state)
        }

        result = await runTurnProgress({
          submissionId: state.submissionId,
          message: state.message,
          pendingImage: state.pendingImage,
          attachment,
          thinkingMessage: state.thinkingMessage,
          turnId: state.turnId,
          after: state.after,
          presentation: state.presentation,
          assistantRendered: state.assistantRendered,
          onStartInFlight: () => {
            state.stage = SUBMISSION_STAGE.START_IN_FLIGHT
            persist(state)
          },
          onTurnAccepted: (turnId) => {
            state.turnId = turnId
            state.stage = SUBMISSION_STAGE.TURN_ACCEPTED
            state.paused = false
            persist(state)
            onAccepted?.(state)
          },
          onPollProgress: ({ after, presentation, assistantRendered } = {}) => {
            if (Number.isInteger(after)) state.after = after
            if (presentation) state.presentation = presentation
            if (typeof assistantRendered === 'boolean') state.assistantRendered = assistantRendered
            if (state.turnId) persist(state)
          },
        })
      } catch (error) {
        const startAcceptanceUnknown = state.stage !== SUBMISSION_STAGE.TURN_ACCEPTED
          && (error?.startAcceptanceUnknown === true
            || ((state.stage === SUBMISSION_STAGE.PRE_START || state.stage === SUBMISSION_STAGE.START_IN_FLIGHT)
              && error?.safePreAcceptFailure !== true))
        if (error?.code === 'SUBMISSION_ID_CONFLICT') {
          state.stage = SUBMISSION_STAGE.START_ACCEPTANCE_UNKNOWN
          state.paused = true
          activeSubmission = null
          retryableSubmission = null
          clearPersisted()
          onStartAcceptanceUnknown?.(state, error)
          return { status: 'submission-conflict', state, error }
        }
        if (startAcceptanceUnknown) {
          state.stage = SUBMISSION_STAGE.START_ACCEPTANCE_UNKNOWN
          state.paused = true
          activeSubmission = state
          retryableSubmission = null
          persist(state)
          onStartAcceptanceUnknown?.(state, error)
          return { status: 'start-acceptance-unknown', state, error }
        }
        if (state.stage === SUBMISSION_STAGE.TURN_ACCEPTED) {
          if (error?.code === 'TURN_FAILED') {
            state.stage = SUBMISSION_STAGE.TURN_FAILED
            activeSubmission = null
            retryableSubmission = null
            clearPersisted()
            onServerFailure?.(state, error)
            return { status: 'turn-failed', state, error }
          }
          if (error?.turnPollTransient === true && state.pollRetryCount < POLL_RETRY_DELAYS_MS.length) {
            const retryNumber = state.pollRetryCount + 1
            const delayMs = POLL_RETRY_DELAYS_MS[state.pollRetryCount]
            state.pollRetryCount = retryNumber
            persist(state)
            onPollRetry?.(state, { retryNumber, delayMs, error })
            await waitForPollRetry(delayMs)
            return execute(state)
          }
          // Ownership already moved to the server. Keep this state active so a
          // reconnect can poll the same turn instead of starting another one.
          state.paused = true
          persist(state)
          onAcceptedFailure?.(state, error)
          return { status: 'accepted-failure', state, error }
        }

        activeSubmission = null
        retryableSubmission = state.uploadedAttachment ? state : null
        if (state.stage === SUBMISSION_STAGE.START_IN_FLIGHT || state.stage === SUBMISSION_STAGE.PRE_START) {
          state.stage = state.uploadedAttachment ? SUBMISSION_STAGE.UPLOADED : SUBMISSION_STAGE.PRE_START
        }
        clearPersisted()
        onPreAcceptFailure?.(state, error)
        return { status: 'pre-accept-failure', state, error }
      }

      state.stage = SUBMISSION_STAGE.TURN_COMPLETED
      state.paused = false
      activeSubmission = null
      retryableSubmission = null
      clearPersisted()
      onCompleted?.(state, result)
      return { status: 'completed', state, result }
    }

    function submit({ draftText, message, pendingImage } = {}) {
      if (activeSubmission) return Promise.resolve({ status: 'busy', state: activeSubmission })
      try {
        const persisted = pendingStore?.read?.()
        if (persisted?.status === 'pending') return Promise.resolve({ status: 'pending-recovery', pending: persisted.pending })
      } catch { /* proceed with the explicit send when storage cannot be read */ }

      const cached = matchesRetryable({ draftText, message, pendingImage })
        ? retryableSubmission
        : null
      retryableSubmission = null
      const state = cached
        ? createState({ draftText, message, pendingImage, uploadedAttachment: cached.uploadedAttachment })
        : createState({ draftText, message, pendingImage })
      activeSubmission = state
      persist(state)
      state.optimisticUserNode = onOptimisticUser?.(state) ?? null
      return startExecution(state)
    }

    function startExecution(state) {
      const promise = execute(state)
      executionPromise = promise
      promise.then(
        () => { if (executionPromise === promise) executionPromise = null },
        () => { if (executionPromise === promise) executionPromise = null },
      )
      return promise
    }

    function resume({ explicit = false } = {}) {
      if (!activeSubmission || activeSubmission.stage !== SUBMISSION_STAGE.TURN_ACCEPTED) {
        return Promise.resolve({ status: 'idle', state: activeSubmission })
      }
      if (activeSubmission.paused && !explicit) {
        return Promise.resolve({ status: 'paused', state: activeSubmission })
      }
      if (executionPromise || resumePromise) return executionPromise ?? resumePromise

      const state = activeSubmission
      state.paused = false
      state.pollRetryCount = 0
      persist(state)
      onResume?.(state)
      resumePromise = startExecution(state).finally(() => {
        resumePromise = null
      })
      return resumePromise
    }

    return Object.freeze({
      submit,
      recover,
      resume,
      hasActive: () => Boolean(activeSubmission),
      getActive: () => activeSubmission,
      getActiveTurnId: () => activeSubmission?.turnId ?? null,
      getRetryable: () => retryableSubmission,
      SUBMISSION_STAGE,
      POLL_RETRY_DELAYS_MS,
    })
  }

  globalThis.VcAiPetSubmission = Object.freeze({
    SUBMISSION_STAGE,
    POLL_RETRY_DELAYS_MS,
    PENDING_SUBMISSION_STORAGE_KEY,
    PENDING_SUBMISSION_SCHEMA_VERSION,
    CLIENT_PENDING_MAX_AGE_MS,
    PENDING_SUBMISSION_MAX_AGE_MS,
    createSubmissionId,
    createPendingSubmissionStore,
    createSubmissionController,
  })
})()
