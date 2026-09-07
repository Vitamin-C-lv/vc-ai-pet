(function installVcComposer(global) {
  const MIN_TEXTAREA_HEIGHT = 44
  const MAX_TEXTAREA_HEIGHT = 132

  function syncComposerTextareaHeight(textarea) {
    if (!textarea?.style) return 0
    textarea.style.height = '0px'
    const scrollHeight = Number(textarea.scrollHeight)
    const contentHeight = Number.isFinite(scrollHeight) && scrollHeight > 0
      ? scrollHeight
      : MIN_TEXTAREA_HEIGHT
    const desiredHeight = Math.min(Math.max(contentHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT)
    textarea.style.height = `${desiredHeight}px`
    textarea.style.overflowY = contentHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden'
    return desiredHeight
  }

  function wireVcComposer({
    form,
    input,
    micButton,
    addButton,
    sendButton,
    emojiController,
    openExistingImagePicker = async () => {},
    sendExistingText = async () => {},
    hasPendingImage = () => false,
    isBusy = () => false,
    showToast = () => {},
    onEmojiToggle = () => {},
  } = {}) {
    if (!input || !addButton || !sendButton) throw new Error('composer input/add/send buttons required')

    let sending = false
    let composing = false

    function sync() {
      const hasText = input.value.trim().length > 0
      const hasImage = Boolean(hasPendingImage?.())
      const canSend = hasText || hasImage
      const disabled = sending || Boolean(isBusy?.())
      addButton.hidden = false
      sendButton.hidden = !canSend
      sendButton.setAttribute('aria-hidden', String(!canSend))
      sendButton.disabled = disabled
      sendButton.setAttribute('aria-label', hasText ? '发送消息' : '发送图片')
      addButton.disabled = disabled
      syncComposerTextareaHeight(input)
      return { hasText, hasImage, canSend }
    }

    async function submit() {
      if (sending || composing || isBusy?.()) return
      const text = input.value.trim()
      if (!text && !hasPendingImage?.()) return
      sending = true
      sync()
      try {
        await sendExistingText(text)
      } finally {
        sending = false
        sync()
      }
    }

    async function openImagePicker() {
      if (sending || isBusy?.()) return
      await openExistingImagePicker?.()
    }

    input.addEventListener('input', sync)
    input.addEventListener('compositionstart', () => {
      composing = true
      input.dataset.composing = 'true'
    })
    input.addEventListener('compositionend', () => {
      composing = false
      delete input.dataset.composing
      sync()
    })
    form?.addEventListener('submit', (event) => {
      event.preventDefault()
      if (composing || event.isComposing || event.keyCode === 229) return
      void submit()
    })
    addButton.type = 'button'
    addButton.addEventListener('click', () => { void openImagePicker() })
    sendButton.type = 'button'
    sendButton.addEventListener('click', () => { void submit() })
    micButton?.addEventListener('click', () => showToast('语音输入后续开放'))

    const controller = {
      sync,
      submit,
      closeEmoji: () => emojiController?.close?.(),
      isComposing: () => composing,
      resize: () => syncComposerTextareaHeight(input),
    }
    onEmojiToggle(false)
    sync()
    return controller
  }

  global.VcAiPetComposer = Object.freeze({
    MAX_TEXTAREA_HEIGHT,
    MIN_TEXTAREA_HEIGHT,
    syncComposerTextareaHeight,
    wireVcComposer,
  })
})(globalThis)
