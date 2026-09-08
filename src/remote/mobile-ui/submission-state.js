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

  function createSubmissionController({
    uploadImage,
    runTurnProgress,
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

    function matchesRetryable({ draftText, message, pendingImage } = {}) {
      return Boolean(
        retryableSubmission
        && retryableSubmission.draftText === draftText
        && retryableSubmission.message === message
        && retryableSubmission.pendingImage === pendingImage,
      )
    }

    function createState({ draftText, message, pendingImage } = {}) {
      return {
        stage: SUBMISSION_STAGE.PRE_UPLOAD,
        draftText,
        message,
        pendingImage,
        uploadedAttachment: null,
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

    async function execute(state) {
      let result
      try {
        let attachment = state.uploadedAttachment
        if (state.pendingImage) {
          if (!attachment) {
            state.stage = SUBMISSION_STAGE.PRE_UPLOAD
            attachment = await uploadImage(state.pendingImage)
            state.uploadedAttachment = attachment
          }
          if (!state.turnId) state.stage = SUBMISSION_STAGE.UPLOADED
        }
        if (!state.turnId) state.stage = SUBMISSION_STAGE.PRE_START

        result = await runTurnProgress({
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
          },
          onTurnAccepted: (turnId) => {
            state.turnId = turnId
            state.stage = SUBMISSION_STAGE.TURN_ACCEPTED
            onAccepted?.(state)
          },
          onPollProgress: ({ after, presentation, assistantRendered } = {}) => {
            if (Number.isInteger(after)) state.after = after
            if (presentation) state.presentation = presentation
            if (typeof assistantRendered === 'boolean') state.assistantRendered = assistantRendered
          },
        })
      } catch (error) {
        const startAcceptanceUnknown = state.stage !== SUBMISSION_STAGE.TURN_ACCEPTED
          && (error?.startAcceptanceUnknown === true
            || ((state.stage === SUBMISSION_STAGE.PRE_START || state.stage === SUBMISSION_STAGE.START_IN_FLIGHT)
              && error?.safePreAcceptFailure !== true))
        if (startAcceptanceUnknown) {
          state.stage = SUBMISSION_STAGE.START_ACCEPTANCE_UNKNOWN
          state.paused = true
          activeSubmission = state
          retryableSubmission = null
          onStartAcceptanceUnknown?.(state, error)
          return { status: 'start-acceptance-unknown', state, error }
        }
        if (state.stage === SUBMISSION_STAGE.TURN_ACCEPTED) {
          if (error?.code === 'TURN_FAILED') {
            state.stage = SUBMISSION_STAGE.TURN_FAILED
            activeSubmission = null
            onServerFailure?.(state, error)
            return { status: 'turn-failed', state, error }
          }
          if (error?.turnPollTransient === true && state.pollRetryCount < POLL_RETRY_DELAYS_MS.length) {
            const retryNumber = state.pollRetryCount + 1
            const delayMs = POLL_RETRY_DELAYS_MS[state.pollRetryCount]
            state.pollRetryCount = retryNumber
            onPollRetry?.(state, { retryNumber, delayMs, error })
            await waitForPollRetry(delayMs)
            return execute(state)
          }
          // Ownership already moved to the server. Keep this state active so a
          // reconnect can poll the same turn instead of starting another one.
          state.paused = true
          onAcceptedFailure?.(state, error)
          return { status: 'accepted-failure', state, error }
        }

        activeSubmission = null
        retryableSubmission = state.uploadedAttachment ? state : null
        if (state.stage === SUBMISSION_STAGE.START_IN_FLIGHT || state.stage === SUBMISSION_STAGE.PRE_START) {
          state.stage = state.uploadedAttachment ? SUBMISSION_STAGE.UPLOADED : SUBMISSION_STAGE.PRE_START
        }
        onPreAcceptFailure?.(state, error)
        return { status: 'pre-accept-failure', state, error }
      }

      state.stage = SUBMISSION_STAGE.TURN_COMPLETED
      state.paused = false
      activeSubmission = null
      retryableSubmission = null
      onCompleted?.(state, result)
      return { status: 'completed', state, result }
    }

    function submit({ draftText, message, pendingImage } = {}) {
      if (activeSubmission) return Promise.resolve({ status: 'busy', state: activeSubmission })

      const cached = matchesRetryable({ draftText, message, pendingImage })
        ? retryableSubmission
        : null
      retryableSubmission = null
      const state = cached ?? createState({ draftText, message, pendingImage })
      state.optimisticUserNode = onOptimisticUser?.(state) ?? null
      activeSubmission = state
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
      onResume?.(state)
      resumePromise = startExecution(state).finally(() => {
        resumePromise = null
      })
      return resumePromise
    }

    return Object.freeze({
      submit,
      resume,
      hasActive: () => Boolean(activeSubmission),
      getActive: () => activeSubmission,
      getActiveTurnId: () => activeSubmission?.turnId ?? null,
      getRetryable: () => retryableSubmission,
      SUBMISSION_STAGE,
      POLL_RETRY_DELAYS_MS,
    })
  }

  globalThis.VcAiPetSubmission = Object.freeze({ SUBMISSION_STAGE, POLL_RETRY_DELAYS_MS, createSubmissionController })
})()
