import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/remote/mobile-ui/proactive-messages.js', import.meta.url), 'utf8')

class Element {
  constructor() {
    this.listeners = new Map()
    this.attributes = new Map()
    this.checked = false
    this.disabled = false
    this.hidden = false
    this.value = ''
    this.textContent = ''
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  setAttribute(name, value) { this.attributes.set(name, value) }

  async emit(type) {
    await Promise.all((this.listeners.get(type) ?? []).map(listener => listener({ target: this, type })))
  }
}

function makePage(hash = '') {
  const elements = new Map()
  const windowListeners = new Map()
  const intervals = new Map()
  const storage = new Map()
  const api = {
    settings: { enabled: true, maxPerDay: 3, quietStart: '22:00', quietEnd: '08:00', timeZone: 'Asia/Shanghai' },
    cursor: 10,
    messages: [],
  }
  const visibleCalls = []
  let nativeEnabled = false
  let permissionRequest = null
  let intervalSequence = 0
  let clearIntervalCount = 0
  let screen = 'home'
  let pendingTurn = false
  const historyRefreshes = []
  const timeouts = new Map()
  let timeoutSequence = 0

  const document = {
    visibilityState: 'visible',
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element())
      return elements.get(selector)
    },
  }

  const sandbox = {
    AbortController,
    document,
    location: { hash },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null },
      setItem(key, value) { storage.set(key, value) },
    },
    setTimeout(callback, delay) { const id = ++timeoutSequence; timeouts.set(id, { callback, delay }); return id },
    clearTimeout(id) { timeouts.delete(id) },
    setInterval(callback, delay) {
      const id = ++intervalSequence
      intervals.set(id, { callback, delay })
      return id
    },
    clearInterval(id) { clearIntervalCount += 1; intervals.delete(id) },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? []
      listeners.push(listener)
      windowListeners.set(type, listeners)
    },
    dispatchEvent(event) {
      for (const listener of windowListeners.get(event.type) ?? []) listener(event)
    },
    fetch: async (path, options = {}) => {
      if (api.hang) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('request aborted'))))
      const url = new URL(path, 'http://pet-ui.test')
      let payload
      if (url.pathname === '/api/pet/proactive/settings' && options.method === 'POST') {
        Object.assign(api.settings, JSON.parse(options.body))
        payload = api.settings
      } else if (url.pathname === '/api/pet/proactive/settings') {
        payload = api.settings
      } else if (url.pathname === '/api/pet/proactive/messages' && url.searchParams.get('latest') === '1') {
        payload = { cursor: api.cursor, messages: [] }
      } else if (url.pathname === '/api/pet/proactive/messages') {
        const after = Number(url.searchParams.get('after') || 0)
        payload = { cursor: api.cursor, messages: api.messages.filter(message => Number(message.cursor) > after) }
      } else if (url.pathname === '/api/pet/proactive/test' && options.method === 'POST') {
        payload = { ok: true }
      } else {
        throw new Error(`Unexpected fixture request: ${options.method || 'GET'} ${url.pathname}`)
      }
      return { ok: true, json: async () => structuredClone(payload) }
    },
    VcAiPetNotifications: {
      isAvailable: async () => true,
      isEnabled: async () => nativeEnabled,
      setEnabled(requested) {
        return new Promise(resolve => {
          permissionRequest = grant => {
            nativeEnabled = requested && grant
            sandbox.dispatchEvent({ type: 'pet:notificationsettingschange' })
            resolve(true)
          }
        })
      },
      setChatVisible(visible) { visibleCalls.push(visible) },
    },
  }
  sandbox.VcAiPetApp = {
    getScreen: () => screen,
    isTurnPending: () => pendingTurn,
    openChat() {
      screen = 'chat'
      sandbox.VcAiPetProactive?.onScreenChanged?.('chat')
    },
    refreshHistory(options) { historyRefreshes.push(options) },
  }
  vm.runInNewContext(source, vm.createContext(sandbox), { filename: 'proactive-messages.js' })

  async function flush() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }

  return {
    sandbox,
    document,
    elements,
    api,
    visibleCalls,
    historyRefreshes,
    abortStalledRequests() { for (const timer of timeouts.values()) if (timer.delay === 15_000) timer.callback() },
    get permissionRequest() { return permissionRequest },
    get clearIntervalCount() { return clearIntervalCount },
    setScreen(value) { screen = value },
    setPending(value) { pendingTurn = value },
    async flush() { await flush() },
  }
}

const page = makePage()
await page.flush()

const deviceSwitch = page.elements.get('#proactive-device-notifications')
const deviceNote = page.elements.get('#proactive-device-note')
assert.equal(deviceSwitch.disabled, false, 'native notification switch is available')

deviceSwitch.checked = true
const deniedChange = deviceSwitch.emit('change')
await page.flush()
assert.equal(typeof page.permissionRequest, 'function', 'enabling notifications waits for native permission')
assert.equal(deviceSwitch.disabled, true, 'the switch waits for the permission result event')
assert.doesNotMatch(deviceNote.textContent, /权限未开启/u, 'the prompt is not reported as denied before its result')
page.permissionRequest(false)
await deniedChange
await page.flush()
assert.equal(deviceSwitch.checked, false, 'the switch reflects denied system permission')
assert.match(deviceNote.textContent, /系统通知权限未开启/u, 'permission denial is visible')

deviceSwitch.checked = true
const grantedChange = deviceSwitch.emit('change')
await page.flush()
page.permissionRequest(true)
await grantedChange
await page.flush()
assert.equal(deviceSwitch.checked, true, 'the switch reflects actual granted permission')

page.sandbox.VcAiPetProactive.onNotificationTap()
await page.flush()
assert.equal(page.sandbox.VcAiPetApp.getScreen(), 'chat', 'native tap opens chat')
assert.equal(page.visibleCalls.at(-1), true, 'visible chat is reported to Android')
assert.equal(page.historyRefreshes.length, 1, 'opening chat refreshes history once')

page.document.visibilityState = 'hidden'
page.sandbox.VcAiPetProactive.onPageVisibilityChanged()
assert.equal(page.visibleCalls.at(-1), false, 'hidden page reports chat as not visible')
assert.equal(page.clearIntervalCount, 1, 'poll interval pauses while hidden')

page.document.visibilityState = 'visible'
page.sandbox.VcAiPetProactive.onPageVisibilityChanged()
await page.flush()
assert.equal(page.visibleCalls.at(-1), true, 'visible chat resumes native visibility state')

const beforeOrdinaryMessage = page.historyRefreshes.length
page.api.cursor += 1
page.sandbox.VcAiPetProactive.onPageVisibilityChanged()
await page.flush()
assert.equal(page.historyRefreshes.length, beforeOrdinaryMessage + 1, 'ordinary archive messages trigger catch-up without a proactive message')

page.setPending(true)
page.api.cursor += 1
page.sandbox.VcAiPetProactive.onPageVisibilityChanged()
await page.flush()
assert.equal(page.historyRefreshes.length, beforeOrdinaryMessage + 1, 'archive catch-up preserves an active turn')
page.setPending(false)
page.sandbox.VcAiPetProactive.onTurnSettled()
assert.equal(page.historyRefreshes.length, beforeOrdinaryMessage + 2, 'settling catches up deferred archive changes')

page.api.hang = true
page.sandbox.VcAiPetProactive.onPageVisibilityChanged()
await page.flush()
page.abortStalledRequests()
await page.flush()
page.api.hang = false
page.api.cursor += 1
page.sandbox.VcAiPetProactive.onPageVisibilityChanged()
await page.flush()
assert.equal(page.historyRefreshes.length, beforeOrdinaryMessage + 3, 'a stalled fetch releases the polling lock and the next connection catches up')

page.setScreen('home')
page.sandbox.VcAiPetProactive.onScreenChanged('home')
assert.equal(page.visibleCalls.at(-1), false, 'leaving chat clears native visibility state')

page.setPending(true)
const refreshCount = page.historyRefreshes.length
page.sandbox.VcAiPetProactive.onScreenChanged('chat')
assert.equal(page.historyRefreshes.length, refreshCount, 'a pending user turn does not trigger a history refresh')

const deepLinkPage = makePage('#chat')
await deepLinkPage.flush()
assert.equal(deepLinkPage.sandbox.VcAiPetApp.getScreen(), 'chat', 'cold #chat launch opens chat')
assert.equal(deepLinkPage.visibleCalls.at(-1), true, 'cold chat launch reports native visibility')

console.log('PASS proactive UI bridge: permission denial/grant event, visible-chat notification suppression, hidden polling pause, pending-turn refresh gate, cold #chat launch')
