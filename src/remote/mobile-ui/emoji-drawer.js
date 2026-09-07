(function installVcEmoji(global) {
  const DEFAULT_EMOJI = Object.freeze([
    '😀', '😄', '😂', '🥹', '😊', '😌', '😍', '🥰', '😘', '😎',
    '🤔', '🫡', '😭', '😤', '😴', '🤗', '🙈', '🙉', '🙊', '🐶',
    '🐾', '❤️', '💛', '💙', '✨', '🌙', '🌟', '🎉', '🍎', '🍓',
    '🍉', '🍜', '🍰', '☕', '🌸', '🌿',
  ])

  function createEmojiRegistry() {
    const providers = new Map([
      ['emoji', () => DEFAULT_EMOJI.map((value) => ({ type: 'emoji', value }))],
      ['stickers', () => []],
    ])
    return {
      register(type, provider) {
        if (typeof provider !== 'function') throw new TypeError('provider must be a function')
        providers.set(type, provider)
      },
      get(type) { return providers.get(type)?.() ?? [] },
    }
  }

  function insertEmoji(textarea, emoji) {
    if (!textarea || textarea.readOnly) return false
    const value = textarea.value || ''
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : value.length
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start
    const insertedEmoji = typeof emoji === 'string' ? emoji : ''
    if (!insertedEmoji) return false
    const maxLength = Number(textarea.maxLength)
    const selectedLength = Math.max(0, end - start)
    const remainingLength = Number.isFinite(maxLength) && maxLength >= 0
      ? maxLength - (value.length - selectedLength)
      : Number.POSITIVE_INFINITY
    if (insertedEmoji.length > remainingLength) return false
    textarea.value = value.slice(0, start) + insertedEmoji + value.slice(end)
    const next = start + insertedEmoji.length
    textarea.setSelectionRange?.(next, next)
    if (typeof global.Event === 'function') textarea.dispatchEvent(new global.Event('input', { bubbles: true }))
    textarea.focus?.({ preventScroll: true })
    return true
  }

  function wireEmojiDrawer({ drawer, input, button, onToggle = () => {} } = {}) {
    if (!drawer || !input || !button) return null
    const registry = createEmojiRegistry()
    const grid = drawer.querySelector('[data-emoji-grid]')
    let open = false

    function render() {
      if (!grid) return
      grid.replaceChildren()
      registry.get('emoji').forEach((item) => {
        if (item?.type !== 'emoji' || typeof item.value !== 'string' || !item.value) return
        const option = document.createElement('button')
        option.type = 'button'
        option.className = 'emoji-item'
        option.dataset.emoji = item.value
        option.textContent = item.value
        option.setAttribute('aria-label', `插入${item.value}`)
        grid.append(option)
      })
    }

    function setOpen(next) {
      open = Boolean(next)
      drawer.dataset.open = String(open)
      drawer.hidden = !open
      button.setAttribute('aria-expanded', String(open))
      onToggle(open)
    }

    button.addEventListener('click', () => setOpen(!open))
    grid?.addEventListener('click', (event) => {
      const option = event.target.closest?.('[data-emoji]')
      if (!option) return
      insertEmoji(input, option.dataset.emoji || '')
    })
    render()
    setOpen(false)

    return {
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen(!open),
      isOpen: () => open,
      registerEmojiProvider(provider) {
        registry.register('emoji', provider)
        render()
      },
      registerStickerProvider(provider) { registry.register('stickers', provider) },
    }
  }

  global.VcAiPetEmoji = Object.freeze({ DEFAULT_EMOJI, createEmojiRegistry, insertEmoji, wireEmojiDrawer })
})(globalThis)
