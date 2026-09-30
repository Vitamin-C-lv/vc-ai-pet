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
    let currentParams = {}

    function render(screen, params, direction) {
      currentParams = params
      goToScreen?.(screen, params, { direction })
    }

    function push(next, params = {}) {
      if (!Object.values(VC_SCREEN).includes(next)) return
      const current = getScreen?.()
      if (current && current !== next) stack.push({ screen: current, params: currentParams })
      render(next, params, 'forward')
    }

    function home() {
      stack.length = 0
      render(VC_SCREEN.HOME, {}, 'back')
    }

    function back({ fallback } = {}) {
      const current = getScreen?.()
      if (current === VC_SCREEN.HOME && stack.length === 0) return false
      const deterministicFallback = fallback
        ?? (current === VC_SCREEN.GALLERY_DETAIL ? VC_SCREEN.GALLERY : VC_SCREEN.HOME)
      const previous = stack.pop()
      render(previous?.screen || deterministicFallback, previous?.params || {}, 'back')
      return true
    }

    return Object.freeze({ push, home, back })
  }

  global.VcAiPetNavigation = Object.freeze({ VC_SCREEN, createVcNavigation })
})(globalThis)
