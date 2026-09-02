const stateLabel = document.querySelector('#state-label')
const sprite = document.querySelector('#pet-sprite')
const happiness = document.querySelector('#happiness')
const energy = document.querySelector('#energy')
const connection = document.querySelector('#connection')
const messages = document.querySelector('#messages')
const form = document.querySelector('#chat-form')
const input = document.querySelector('#chat-input')

function setOnline(online) { connection.classList.toggle('online', online); connection.setAttribute('aria-label', online ? '已同步' : '同步中') }
function number(value) { return `${Math.round(Number(value || 0) * 100)}%` }
function line(role, text) { const node = document.createElement('p'); node.className = `${role}-line`; node.textContent = `${role === 'user' ? '主人' : '李花花'}：${text}`; messages.append(node); messages.scrollTop = messages.scrollHeight }

async function refresh() {
  try {
    const response = await fetch('/api/pet/state', { cache: 'no-store' })
    if (!response.ok) throw new Error('state unavailable')
    const state = await response.json()
    stateLabel.textContent = `当前状态：${state.visualState || 'idle'}`
    happiness.textContent = number(state.emotion?.happiness)
    energy.textContent = number(state.emotion?.energy)
    if (state.sprite) sprite.src = `/assets/${state.sprite}`
    setOnline(true)
  } catch { setOnline(false) }
}

async function action(action) {
  try {
    const response = await fetch('/api/pet/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
    if (!response.ok) throw new Error('action unavailable')
    sprite.classList.add('active'); setTimeout(() => sprite.classList.remove('active'), 240)
    await refresh()
  } catch { setOnline(false) }
}

document.querySelector('#pet-button').addEventListener('click', () => action('click'))
document.querySelector('#play-button').addEventListener('click', () => action('double_click'))
document.querySelector('#long-button').addEventListener('click', () => action('long_press'))
let pressTimer = null
let clickTimer = null
sprite.addEventListener('pointerdown', () => { pressTimer = setTimeout(() => { pressTimer = null; action('long_press') }, 700) })
sprite.addEventListener('pointerup', () => {
  if (!pressTimer) return
  clearTimeout(pressTimer); pressTimer = null
  if (clickTimer) clearTimeout(clickTimer)
  clickTimer = setTimeout(() => { clickTimer = null; action('click') }, 220)
})
sprite.addEventListener('pointercancel', () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = null })
sprite.addEventListener('dblclick', () => {
  if (pressTimer) clearTimeout(pressTimer); pressTimer = null
  if (clickTimer) clearTimeout(clickTimer); clickTimer = null
  action('double_click')
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const message = input.value.trim()
  if (!message) return
  input.value = ''; input.disabled = true; line('user', message)
  try {
    const response = await fetch('/api/pet/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) })
    const result = await response.json()
    line('pet', result?.ok ? result.text : (result?.petLine || '花花脑袋刚刚卡了一下……'))
  } catch { line('pet', '花花脑袋刚刚卡了一下……'); setOnline(false) } finally { input.disabled = false; input.focus(); refresh() }
})

refresh(); setInterval(refresh, 1500)
