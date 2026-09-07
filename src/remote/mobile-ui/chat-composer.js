(function installVcComposer(global) {
  function wireVcComposer({
    form,
    input,
    micButton,
    emojiButton,
    actionButton,
    emojiController,
    openExistingImagePicker = async () => {},
    sendExistingText = async () => {},
    hasPendingImage = () => false,
    isBusy = () => false,
    showToast = () => {},
    onEmojiToggle = () => {},
  } = {}) {
    if (!input || !actionButton) throw new Error('composer input/action button required')

    let sending = false
    let composing = false

    function resizeInput() {
      input.style.height = 'auto'
      const contentHeight = Number(input.scrollHeight) || 44
      const maxHeight = 132
      input.style.height = `${Math.min(contentHeight, maxHeight)}px`
      input.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
    }

    function sync() {
      const hasText = input.value.trim().length > 0
      const hasImage = Boolean(hasPendingImage?.())
      const canSend = hasText || hasImage
      actionButton.dataset.mode = canSend ? 'send' : 'add'
      actionButton.textContent = canSend ? '发送' : '+'
      actionButton.setAttribute('aria-label', canSend
        ? (hasText ? '发送消息' : '发送图片')
        : '添加图片')
      actionButton.disabled = sending || Boolean(isBusy?.())
      resizeInput()
    }

    async function submit() {
      if (sending) return
      const text = input.value.trim()
      if (!text && !hasPendingImage?.()) {
        await openExistingImagePicker?.()
        return
      }
      sending = true
      sync()
      try {
        await sendExistingText(text)
      } finally {
        sending = false
        sync()
      }
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
    actionButton.type = 'button'
    actionButton.addEventListener('click', () => { void submit() })
    micButton?.addEventListener('click', () => showToast('语音输入后续开放'))

    const controller = {
      sync,
      submit,
      closeEmoji: () => emojiController?.close?.(),
      isComposing: () => composing,
      resize: resizeInput,
    }
    onEmojiToggle(false)
    sync()
    return controller
  }

  global.VcAiPetComposer = Object.freeze({ wireVcComposer })
})(globalThis)
