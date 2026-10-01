'use strict'

function createThinkingIndicator({ container }) {
  if (!container) throw new Error('thinking indicator container is required')

  const indicator = document.createElement('div')
  indicator.className = 'thinking-indicator'
  indicator.hidden = true
  indicator.setAttribute('role', 'status')
  indicator.setAttribute('aria-live', 'polite')
  indicator.setAttribute('aria-atomic', 'true')

  const paw = document.createElement('span')
  paw.className = 'thinking-indicator__paw'
  paw.setAttribute('aria-hidden', 'true')
  paw.textContent = '🐾'

  const label = document.createElement('span')
  label.className = 'thinking-indicator__label'

  const dots = document.createElement('span')
  dots.className = 'thinking-indicator__dots'
  dots.setAttribute('aria-hidden', 'true')
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement('span')
    dot.className = 'thinking-indicator__dot'
    dots.append(dot)
  }

  indicator.append(paw, label, dots)
  container.append(indicator)

  let active = false
  let defaultLabel = '花花想一想'

  function setStage(stage) {
    label.textContent = typeof stage === 'string' && stage.trim() ? stage.trim() : defaultLabel
  }

  function start({ vision = false } = {}) {
    defaultLabel = vision ? '花花认真看看' : '花花想一想'
    active = true
    setStage()
    indicator.hidden = false
  }

  function stop() {
    active = false
    indicator.hidden = true
  }

  return Object.freeze({
    start,
    setStage,
    stop,
    isActive: () => active,
  })
}

globalThis.VcAiPetThinkingIndicator = Object.freeze({ create: createThinkingIndicator })
