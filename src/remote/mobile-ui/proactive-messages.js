(() => {
  const STORAGE_KEY = 'vc-ai-pet-proactive-state-v1'
  const POLL_INTERVAL_MS = 15_000
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    maxPerDay: 3,
    quietStart: '22:00',
    quietEnd: '08:00',
    timeZone: 'Asia/Shanghai',
  })

  const enabledInput = document.querySelector('#proactive-enabled')
  const maxPerDayInput = document.querySelector('#proactive-max-per-day')
  const quietStartInput = document.querySelector('#proactive-quiet-start')
  const quietEndInput = document.querySelector('#proactive-quiet-end')
  const deviceNotificationsInput = document.querySelector('#proactive-device-notifications')
  const deviceNotificationsNote = document.querySelector('#proactive-device-note')
  const testButton = document.querySelector('#proactive-test')
  const settingsStatus = document.querySelector('#proactive-settings-status')
  const unreadBadge = document.querySelector('#chat-unread-badge')
  const toast = document.querySelector('#proactive-toast')
  const settingsOpenButton = document.querySelector('#home-settings-open')

  let settings = { ...DEFAULT_SETTINGS }
  let settingsReady = false
  let settingsBusy = false
  let polling = false
  let pollTimer = null
  let toastTimer = null
  let nativeChatVisible = null
  let deviceRefreshSequence = 0
  let devicePermissionDenied = false
  let pendingDeviceChange = null
  const localState = readLocalState()

  function readLocalState() {
    try {
      const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) || '{}')
      return {
        cursor: typeof stored.cursor === 'string' ? stored.cursor : '',
        readCursor: typeof stored.readCursor === 'string' ? stored.readCursor : '',
        unreadIds: Array.isArray(stored.unreadIds) ? stored.unreadIds.map(String) : [],
        seenIds: Array.isArray(stored.seenIds) ? stored.seenIds.map(String) : [],
      }
    } catch {
      return { cursor: '', readCursor: '', unreadIds: [], seenIds: [] }
    }
  }

  function saveLocalState() {
    try { globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(localState)) } catch {}
    renderUnreadBadge()
  }

  function renderUnreadBadge() {
    const count = localState.unreadIds.length
    unreadBadge.hidden = count === 0
    unreadBadge.textContent = count > 9 ? '9+' : String(count)
    unreadBadge.setAttribute('aria-label', `${count} 条未读主动消息`)
  }

  async function requestJson(path, options = {}) {
    const controller = new AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await globalThis.fetch(path, { cache: 'no-store', ...options, signal: controller.signal })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error || 'request-failed')
      return payload
    } finally { globalThis.clearTimeout(timer) }
  }

  function renderSettings() {
    enabledInput.checked = settings.enabled === true
    maxPerDayInput.value = String(settings.maxPerDay)
    quietStartInput.value = settings.quietStart
    quietEndInput.value = settings.quietEnd
    for (const control of [enabledInput, maxPerDayInput, quietStartInput, quietEndInput]) {
      control.disabled = !settingsReady || settingsBusy
    }
    testButton.disabled = settingsBusy
  }

  function applySettings(next) {
    settings = { ...DEFAULT_SETTINGS, ...next }
    settingsReady = true
    renderSettings()
  }

  async function loadSettings() {
    try {
      applySettings(await requestJson('/api/pet/proactive/settings'))
      settingsStatus.textContent = ''
    } catch {
      settingsStatus.textContent = '暂时无法读取主动消息设置，请稍后重试。'
      renderSettings()
    }
  }

  async function saveSettings(patch, successText) {
    if (!settingsReady || settingsBusy) return
    const previous = { ...settings }
    settingsBusy = true
    renderSettings()
    settingsStatus.textContent = '正在保存…'
    try {
      applySettings(await requestJson('/api/pet/proactive/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }))
      settingsStatus.textContent = successText
    } catch {
      settings = previous
      settingsReady = true
      renderSettings()
      settingsStatus.textContent = '设置没有保存成功，请重试。'
    } finally {
      settingsBusy = false
      renderSettings()
    }
  }

  function getNativeNotifications() {
    const bridge = globalThis.VcAiPetNotifications
    if (!bridge || typeof bridge.setEnabled !== 'function' || typeof bridge.isEnabled !== 'function') return null
    return bridge
  }

  async function refreshDeviceNotificationToggle() {
    const refreshSequence = ++deviceRefreshSequence
    const bridge = getNativeNotifications()
    let available = Boolean(bridge)
    try {
      if (available && typeof bridge.isAvailable === 'function') available = await bridge.isAvailable()
    } catch { available = false }
    if (refreshSequence !== deviceRefreshSequence) return
    if (!available) {
      deviceNotificationsInput.checked = false
      deviceNotificationsInput.disabled = true
      deviceNotificationsNote.textContent = '此设备暂不支持系统通知'
      return false
    }
    try {
      const enabled = await bridge.isEnabled() === true
      if (refreshSequence !== deviceRefreshSequence) return
      deviceNotificationsInput.checked = enabled
      deviceNotificationsInput.disabled = Boolean(pendingDeviceChange)
      if (enabled) devicePermissionDenied = false
      deviceNotificationsNote.textContent = devicePermissionDenied
        ? '系统通知权限未开启，可在系统设置中允许后重试。'
        : '仅影响这台设备'
      return enabled
    } catch {
      if (refreshSequence !== deviceRefreshSequence) return
      deviceNotificationsInput.checked = false
      deviceNotificationsInput.disabled = true
      deviceNotificationsNote.textContent = '暂时无法读取设备通知状态'
      return false
    }
  }

  function onNativeNotificationSettingsChanged() {
    const pending = pendingDeviceChange
    const refresh = refreshDeviceNotificationToggle()
    if (!pending) return
    void refresh.then(enabled => {
      if (pendingDeviceChange !== pending) return
      pendingDeviceChange = null
      pending.resolve(enabled === true)
    })
  }

  function sendNativeChatVisibility() {
    const bridge = getNativeNotifications()
    if (typeof bridge?.setChatVisible !== 'function') return
    const visible = globalThis.VcAiPetApp?.getScreen?.() === 'chat' && document.visibilityState !== 'hidden'
    if (visible === nativeChatVisible) return
    nativeChatVisible = visible
    try { Promise.resolve(bridge.setChatVisible(visible)).catch(() => {}) } catch {}
  }

  function markRead() {
    localState.readCursor = localState.cursor
    localState.unreadIds = []
    saveLocalState()
    hideToast()
  }

  function showToast() {
    toast.hidden = false
    globalThis.clearTimeout(toastTimer)
    toastTimer = globalThis.setTimeout(hideToast, 5_000)
  }

  function hideToast() {
    toast.hidden = true
    globalThis.clearTimeout(toastTimer)
    toastTimer = null
  }

  function rememberMessageId(id) {
    if (localState.seenIds.includes(id)) return false
    localState.seenIds.push(id)
    if (localState.seenIds.length > 64) localState.seenIds.splice(0, localState.seenIds.length - 64)
    return true
  }

  async function establishBaseline() {
    const latest = await requestJson('/api/pet/proactive/messages?latest=1')
    localState.cursor = String(latest.cursor ?? 0)
    localState.readCursor = localState.cursor
    saveLocalState()
  }

  async function pollMessages() {
    if (polling || document.visibilityState === 'hidden') return
    polling = true
    try {
      if (!localState.cursor) await establishBaseline()
      const result = await requestJson(`/api/pet/proactive/messages?after=${encodeURIComponent(localState.cursor || '0')}`)
      const historyChanged = result.cursor != null && String(result.cursor) !== localState.cursor
      const newMessages = []
      for (const message of result.messages || []) {
        if (message?.id == null) continue
        const id = String(message.id)
        if (!rememberMessageId(id)) continue
        newMessages.push(message)
      }
      if (result.cursor != null) localState.cursor = String(result.cursor)

      const chatIsOpen = globalThis.VcAiPetApp?.getScreen?.() === 'chat'
      if (newMessages.length && chatIsOpen) {
        for (const message of newMessages) globalThis.VcAiPetApp?.appendProactiveMessage?.(message)
        markRead()
      } else if (newMessages.length) {
        for (const message of newMessages) {
          const id = String(message.id)
          if (!localState.unreadIds.includes(id)) localState.unreadIds.push(id)
        }
        saveLocalState()
        showToast()
      } else {
        saveLocalState()
      }
      // The durable cursor also advances for ordinary conversation messages.
      // Catch up after a reload or a change of endpoint without waiting for a
      // new proactive message to arrive.
      if (historyChanged && chatIsOpen && !globalThis.VcAiPetApp?.isTurnPending?.()) {
        void globalThis.VcAiPetApp?.refreshHistory?.({ preserveViewport: true })
      }
    } catch {}
    finally { polling = false }
  }

  function onNotificationTap() {
    const wasChatOpen = globalThis.VcAiPetApp?.getScreen?.() === 'chat'
    globalThis.VcAiPetApp?.openChat?.()
    if (wasChatOpen && globalThis.VcAiPetApp?.getScreen?.() === 'chat') {
      if (!globalThis.VcAiPetApp?.isTurnPending?.()) {
        void globalThis.VcAiPetApp?.refreshHistory?.({ preserveViewport: true })
      }
      void pollMessages()
    }
  }

  function onScreenChanged(screen) {
    sendNativeChatVisibility()
    if (screen === 'chat') {
      markRead()
      if (!globalThis.VcAiPetApp?.isTurnPending?.()) {
        void globalThis.VcAiPetApp?.refreshHistory?.({ preserveViewport: true })
      }
    }
  }

  function onPageVisibilityChanged() {
    sendNativeChatVisibility()
    if (document.visibilityState === 'hidden') {
      globalThis.clearInterval(pollTimer)
      pollTimer = null
    } else {
      void pollMessages()
      if (pollTimer == null) pollTimer = globalThis.setInterval(pollMessages, POLL_INTERVAL_MS)
    }
  }

  function onTurnSettled() {
    if (globalThis.VcAiPetApp?.getScreen?.() === 'chat' && !globalThis.VcAiPetApp?.isTurnPending?.()) {
      void globalThis.VcAiPetApp?.refreshHistory?.({ preserveViewport: true })
    }
  }

  async function runTestMessage() {
    testButton.disabled = true
    settingsStatus.textContent = '正在请花花给主人发一条消息…'
    try {
      await requestJson('/api/pet/proactive/test', { method: 'POST' })
      settingsStatus.textContent = '花花的试发消息已经出发。'
      await pollMessages()
    } catch {
      settingsStatus.textContent = '试发没有成功，请稍后重试。'
    } finally { renderSettings() }
  }

  enabledInput.addEventListener('change', () => {
    void saveSettings({ enabled: enabledInput.checked }, enabledInput.checked ? '花花可以主动来找你了。' : '花花会先安静一会儿。')
  })
  maxPerDayInput.addEventListener('change', () => {
    void saveSettings({ maxPerDay: Number(maxPerDayInput.value) }, '每天的主动消息上限已更新。')
  })
  quietStartInput.addEventListener('change', () => {
    void saveSettings({ quietStart: quietStartInput.value }, '安静时间已更新。')
  })
  quietEndInput.addEventListener('change', () => {
    void saveSettings({ quietEnd: quietEndInput.value }, '安静时间已更新。')
  })
  deviceNotificationsInput.addEventListener('change', async () => {
    const requested = deviceNotificationsInput.checked
    const bridge = getNativeNotifications()
    deviceNotificationsInput.disabled = true
    deviceNotificationsNote.textContent = '正在更新设备通知…'
    try {
      if (!bridge) throw new Error('notifications-unavailable')
      let permissionResult = null
      if (requested) {
        permissionResult = new Promise(resolve => { pendingDeviceChange = { resolve } })
      }
      await bridge.setEnabled(requested)
      const enabled = requested
        ? await permissionResult
        : await refreshDeviceNotificationToggle()
      devicePermissionDenied = requested && enabled !== true
      if (requested && !enabled) {
        deviceNotificationsNote.textContent = '系统通知权限未开启，可在系统设置中允许后重试。'
      } else {
        if (!requested) devicePermissionDenied = false
        deviceNotificationsNote.textContent = enabled ? '仅影响这台设备' : '此设备通知已关闭'
      }
    } catch {
      if (pendingDeviceChange) pendingDeviceChange = null
      deviceNotificationsInput.checked = !requested
      deviceNotificationsNote.textContent = '设备通知设置没有更新，请重试。'
    } finally { deviceNotificationsInput.disabled = false }
  })
  testButton.addEventListener('click', () => { void runTestMessage() })
  settingsOpenButton.addEventListener('click', () => { void loadSettings(); void refreshDeviceNotificationToggle() })
  toast.addEventListener('click', onNotificationTap)
  globalThis.addEventListener('hashchange', () => {
    if (globalThis.location.hash === '#chat') onNotificationTap()
  })
  globalThis.addEventListener('pet:notificationtap', onNotificationTap)
  globalThis.addEventListener('pet:notificationsettingschange', onNativeNotificationSettingsChanged)

  globalThis.VcAiPetProactive = Object.freeze({
    openChat: () => globalThis.VcAiPetApp?.openChat?.(),
    markRead,
    onNotificationTap,
    onScreenChanged,
    onPageVisibilityChanged,
    onTurnSettled,
    refreshHistory: options => globalThis.VcAiPetApp?.refreshHistory?.(options),
  })

  renderSettings()
  renderUnreadBadge()
  void refreshDeviceNotificationToggle()
  if (globalThis.location.hash === '#chat') onNotificationTap()
  else onScreenChanged(globalThis.VcAiPetApp?.getScreen?.())
  void pollMessages()
  if (document.visibilityState !== 'hidden') pollTimer = globalThis.setInterval(pollMessages, POLL_INTERVAL_MS)
})()
