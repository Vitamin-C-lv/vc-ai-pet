(function attachHomeSpriteAnimations(global) {
  const asset = (filename) => `/assets/${filename}`
  const frames = (state, count) => Array.from({ length: count }, (_, index) => asset(`home-${state}-${String(index + 1).padStart(2, '0')}.png`))

  const HOME_SPRITE_ANIMATIONS = Object.freeze({
    idle: Object.freeze({ frames: frames('idle', 4), durations: Object.freeze([560, 300, 360, 820]) }),
    thinking: Object.freeze({ frames: frames('thinking', 4), durations: Object.freeze([520, 330, 380, 720]) }),
    happy: Object.freeze({ frames: frames('happy', 4), durations: Object.freeze([360, 240, 320, 520]) }),
    excited: Object.freeze({ frames: frames('excited', 4), durations: Object.freeze([280, 220, 270, 430]) }),
    relaxed: Object.freeze({ frames: frames('relaxed', 4), durations: Object.freeze([680, 390, 460, 760]) }),
    waiting: Object.freeze({ frames: frames('waiting', 4), durations: Object.freeze([640, 360, 420, 760]) }),
    curious: Object.freeze({ frames: frames('curious', 4), durations: Object.freeze([460, 280, 360, 620]) }),
    confused: Object.freeze({ frames: frames('confused', 4), durations: Object.freeze([430, 260, 340, 580]) }),
    sleep: Object.freeze({ frames: frames('sleep', 4), durations: Object.freeze([740, 430, 520, 900]) }),
    dreaming: Object.freeze({ frames: frames('dreaming', 4), durations: Object.freeze([780, 470, 560, 930]) }),
    walk: Object.freeze({ frames: frames('walk', 6), durations: Object.freeze([180, 180, 180, 180, 180, 180]) }),
  })

  function sourceMatches(image, expected) {
    const current = image.currentSrc || image.src || image.getAttribute?.('src') || ''
    return current === expected || current.endsWith(expected)
  }

  function createHomeSpriteAnimator({
    image,
    animations = HOME_SPRITE_ANIMATIONS,
    reducedMotion = () => global.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true,
    setTimer = global.setTimeout.bind(global),
    clearTimer = global.clearTimeout.bind(global),
    onFrameError = () => {},
  } = {}) {
    let timer = null
    let generation = 0
    let state = null
    let fallback = asset('idle-front.png')
    let frameIndex = 0
    let active = true
    let expectedFrame = null

    function stop() {
      generation += 1
      if (timer !== null) clearTimer(timer)
      timer = null
    }

    function showFallback() {
      stop()
      expectedFrame = null
      image.src = fallback
    }

    function showFrame(index) {
      const animation = animations[state]
      if (!animation) return showFallback()
      frameIndex = index % animation.frames.length
      expectedFrame = animation.frames[frameIndex]
      image.src = expectedFrame
    }

    function schedule(token) {
      const animation = animations[state]
      if (!active || reducedMotion() || !animation) return
      const delay = animation.durations[frameIndex] ?? 400
      timer = setTimer(() => {
        if (token !== generation || !active || reducedMotion()) return
        showFrame(frameIndex + 1)
        schedule(token)
      }, delay)
    }

    function preload(animation) {
      const ImageConstructor = image.ownerDocument?.defaultView?.Image ?? global.Image
      if (typeof ImageConstructor !== 'function') return
      animation.frames.slice(1).forEach((frame) => {
        const candidate = new ImageConstructor()
        candidate.src = frame
      })
    }

    function setPresentation(nextState, nextFallback) {
      fallback = typeof nextFallback === 'string' && nextFallback ? asset(nextFallback) : fallback
      if (state === nextState) return
      stop()
      state = nextState
      frameIndex = 0
      const animation = animations[state]
      if (!animation || reducedMotion()) return showFallback()
      const token = generation
      showFrame(0)
      preload(animation)
      schedule(token)
    }

    function setActive(nextActive) {
      const shouldBeActive = nextActive === true
      if (active === shouldBeActive) return
      active = shouldBeActive
      stop()
      if (!active || reducedMotion() || !animations[state]) return
      const token = generation
      schedule(token)
    }

    image.addEventListener('error', () => {
      if (!expectedFrame || !sourceMatches(image, expectedFrame)) return
      const failedFrame = expectedFrame
      showFallback()
      onFrameError({ state, frame: failedFrame, fallback })
    })

    return Object.freeze({
      setPresentation,
      setActive,
      destroy: stop,
      debug: () => ({ state, frameIndex, active, fallback, expectedFrame, running: timer !== null }),
    })
  }

  global.VcAiPetHomeSpriteAnimations = Object.freeze({ HOME_SPRITE_ANIMATIONS, createHomeSpriteAnimator })
})(globalThis)
