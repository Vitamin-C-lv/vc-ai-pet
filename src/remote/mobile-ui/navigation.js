(function installVcNavigation(global) {
  const VC_SCREEN = Object.freeze({
    HOME: 'home',
    HOUSE: 'house',
    CHAT: 'chat',
    GALLERY: 'gallery',
    GALLERY_DETAIL: 'gallery-detail',
    DREAMS: 'dreams',
  })

  function createVcNavigation({ getScreen, goToScreen } = {}) {
    const stack = []

    function push(next, params = {}) {
      if (!Object.values(VC_SCREEN).includes(next)) return
      const current = getScreen?.()
      if (current && current !== next) stack.push(current)
      goToScreen?.(next, params)
    }

    function home() {
      stack.length = 0
      goToScreen?.(VC_SCREEN.HOME, {})
    }

    function back({ fallback } = {}) {
      const current = getScreen?.()
      const deterministicFallback = fallback
        ?? (current === VC_SCREEN.GALLERY_DETAIL ? VC_SCREEN.GALLERY : VC_SCREEN.HOME)
      const previous = stack.pop()
      goToScreen?.(previous || deterministicFallback, {})
    }

    return Object.freeze({ push, home, back })
  }

  global.VcAiPetNavigation = Object.freeze({ VC_SCREEN, createVcNavigation })
})(globalThis)
