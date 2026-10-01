'use strict'

function createReasoningDebug({ panel, openButton, closeButton, toggle, status, messages }) {
  let enabled = false
  let disclosureSequence = 0
  const stageLabels = { reply: '聊天回复', 'visual-search': '图库检索', 'visual-step': '图像检查' }

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error('reasoning-debug-unavailable')
    return response.json()
  }

  function decorate(button, turnId) {
    if (turnId) button.dataset.turnId = turnId
    button.disabled = !enabled || !button.dataset.turnId
    button.classList.toggle('reasoning-debug-link', !button.disabled)
    if (!button.disabled) {
      button.setAttribute('aria-expanded', 'false')
      button.title = '查看这一轮的模型推理输出'
    } else {
      button.removeAttribute('aria-expanded')
      button.removeAttribute('aria-controls')
      button.removeAttribute('title')
    }
  }

  function applySettings(settings) {
    enabled = settings.reasoningDebugEnabled === true
    toggle.checked = enabled
    messages.querySelectorAll('.reasoning-disclosure').forEach(node => node.remove())
    messages.querySelectorAll('button.thinking-meta').forEach(button => decorate(button))
  }

  async function loadSettings() {
    toggle.disabled = true
    try {
      applySettings(await request('/api/pet/developer/settings'))
      status.textContent = ''
    } catch {
      status.textContent = '暂时无法读取设置，请稍后重试。'
    } finally { toggle.disabled = false }
  }

  function close() {
    panel.hidden = true
    openButton.focus({ preventScroll: true })
  }

  openButton.addEventListener('click', () => {
    panel.hidden = false
    closeButton.focus({ preventScroll: true })
    void loadSettings()
  })
  closeButton.addEventListener('click', close)
  panel.addEventListener('click', event => { if (event.target === panel) close() })
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close() }
    // Keep keyboard navigation in the settings sheet.
    if (event.key === 'Tab') {
      const stops = [...panel.querySelectorAll('button, summary, input')].filter(node => !node.disabled && node.getClientRects().length)
      const first = stops[0], last = stops.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  })
  toggle.addEventListener('change', async () => {
    const next = toggle.checked
    toggle.disabled = true
    status.textContent = '正在保存…'
    try {
      applySettings(await request('/api/pet/developer/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reasoningDebugEnabled: next }),
      }))
      status.textContent = enabled ? '已开启。新对话的耗时可以点开查看。' : '已关闭推理调试。'
    } catch {
      toggle.checked = enabled
      status.textContent = '设置没有保存成功，请重试。'
    } finally { toggle.disabled = false }
  })

  messages.addEventListener('click', async event => {
    const button = event.target.closest('button.thinking-meta[data-turn-id]')
    if (!button || button.disabled || !enabled) return
    const previous = button.parentNode.querySelector('.reasoning-disclosure')
    if (previous) {
      previous.remove()
      button.setAttribute('aria-expanded', 'false')
      return
    }
    const disclosure = document.createElement('section')
    disclosure.className = 'reasoning-disclosure'
    disclosure.id = `reasoning-disclosure-${++disclosureSequence}`
    disclosure.setAttribute('aria-label', '本地模型推理输出')
    button.setAttribute('aria-controls', disclosure.id)
    button.setAttribute('aria-expanded', 'true')
    const heading = document.createElement('h3')
    heading.textContent = '本地模型 · 推理输出'
    const content = document.createElement('div')
    content.className = 'reasoning-disclosure-content'
    content.textContent = '正在读取…'
    disclosure.append(heading, content)
    button.after(disclosure)
    try {
      const trace = await request(`/api/pet/developer/reasoning/${encodeURIComponent(button.dataset.turnId)}`)
      if (!enabled || !disclosure.isConnected) return
      content.replaceChildren()
      if (!trace.calls?.length) {
        content.textContent = trace.status === 'unavailable'
          ? '这一轮没有保存推理记录。开启后发送的新消息才会记录，最近保留 32 轮。'
          : trace.status === 'running'
            ? '模型还在处理，暂未返回推理文本。完成后可以重新展开。'
            : '这一轮没有收到本地模型输出，因此没有可展开的推理文本。'
        return
      }
      for (const call of trace.calls) {
        const title = document.createElement('h4')
        const seconds = Number.isFinite(call.durationMs) ? ` · ${(call.durationMs / 1000).toFixed(1)} 秒` : ''
        title.textContent = `${call.index}. ${stageLabels[call.stage] ?? '模型调用'}${seconds}`
        const text = document.createElement(call.text ? 'pre' : 'p')
        text.textContent = call.text || `这次调用未返回独立的推理文本${call.effort ? `（推理强度：${call.effort}）` : ''}。`
        content.append(title, text)
      }
      if (trace.status === 'running') {
        const pending = document.createElement('p')
        pending.textContent = '这一轮仍在进行，完成后重新展开可查看后续调用。'
        content.append(pending)
      }
    } catch {
      content.textContent = '暂时无法读取推理记录。请检查连接与开发调试开关，再点开重试。'
    } finally {
      if (enabled && disclosure.isConnected) {
        const region = disclosure.getBoundingClientRect()
        const viewport = messages.getBoundingClientRect()
        const delta = region.top < viewport.top || region.height > viewport.height
          ? region.top - viewport.top
          : Math.max(0, region.bottom - viewport.bottom + 8)
        // Reveal the opened details inside the chat, without moving the page.
        messages.scrollTop += delta
      }
    }
  })

  return Object.freeze({ loadSettings, decorate, close, isOpen: () => !panel.hidden })
}

globalThis.VcAiPetReasoningDebug = Object.freeze({ create: createReasoningDebug })
