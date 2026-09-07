(() => {
  const SUBMISSION_STAGE = Object.freeze({
    PRE_UPLOAD: 'PRE_UPLOAD',
    UPLOADED: 'UPLOADED',
    TURN_ACCEPTED: 'TURN_ACCEPTED',
    TURN_COMPLETED: 'TURN_COMPLETED',
    TURN_FAILED: 'TURN_FAILED',
  })

  function createSubmissionController({
    uploadImage,
    runTurnProgress,
    onOptimisticUser,
    onAccepted,
    onCompleted,
    onPreAcceptFailure,
    onAcceptedFailure,
    onServerFailure,
    onResume,
  } = {}) {
    let activeSubmission = null
    let retryableSubmission = null
    let resumePromise = null

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

        result = await runTurnProgress({
          message: state.message,
          pendingImage: state.pendingImage,
          attachment,
          thinkingMessage: state.thinkingMessage,
          turnId: state.turnId,
          after: state.after,
          presentation: state.presentation,
          assistantRendered: state.assistantRendered,
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
        if (state.stage === SUBMISSION_STAGE.TURN_ACCEPTED) {
          if (error?.code === 'TURN_FAILED') {
            state.stage = SUBMISSION_STAGE.TURN_FAILED
            activeSubmission = null
            onServerFailure?.(state, error)
            return { status: 'turn-failed', state, error }
          }
          // Ownership already moved to the server. Keep this state active so a
          // reconnect can poll the same turn instead of starting another one.
          onAcceptedFailure?.(state, error)
          return { status: 'accepted-failure', state, error }
        }

        activeSubmission = null
        retryableSubmission = state.uploadedAttachment ? state : null
        onPreAcceptFailure?.(state, error)
        return { status: 'pre-accept-failure', state, error }
      }

      state.stage = SUBMISSION_STAGE.TURN_COMPLETED
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
      return execute(state)
    }

    function resume() {
      if (!activeSubmission || activeSubmission.stage !== SUBMISSION_STAGE.TURN_ACCEPTED) {
        return Promise.resolve({ status: 'idle', state: activeSubmission })
      }
      if (resumePromise) return resumePromise

      const state = activeSubmission
      onResume?.(state)
      resumePromise = execute(state).finally(() => {
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
    })
  }

  globalThis.VcAiPetSubmission = Object.freeze({ SUBMISSION_STAGE, createSubmissionController })
})()
