const stateLabel = document.querySelector('#state-label')
const sprite = document.querySelector('#pet-sprite')
const happiness = document.querySelector('#happiness')
const energy = document.querySelector('#energy')
const connection = document.querySelector('#connection')
const messages = document.querySelector('#messages')
const form = document.querySelector('#chat-form')
const input = document.querySelector('#chat-input')
const sendButton = document.querySelector('#send-button')
const imageButton = document.querySelector('#image-button')
const imageInput = document.querySelector('#image-input')
const imagePreview = document.querySelector('#image-preview')
const imageThumbnail = document.querySelector('#image-thumbnail')
const removeImage = document.querySelector('#remove-image')
const imageStatus = document.querySelector('#image-status')

const MAX_LONG_EDGE = 1920
const IMAGE_QUALITY = 0.9
const MAX_IMAGE_DATA_URL_BYTES = 7 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
let selectedImage = null
let imageProcessing = false

function setOnline(online) { connection.classList.toggle('online', online); connection.setAttribute('aria-label', online ? '已同步' : '同步中') }
function number(value) { return `${Math.round(Number(value || 0) * 100)}%` }
function line(role, text) { const node = document.createElement('p'); node.className = `${role}-line`; node.textContent = `${role === 'user' ? '主人' : '李花花'}：${text}`; messages.append(node); messages.scrollTop = messages.scrollHeight }

function updateSendButton() {
  sendButton.disabled = imageProcessing || (!input.value.trim() && !selectedImage)
}

function clearImageSelection({ clearStatus = true } = {}) {
  selectedImage = null
  imageThumbnail.removeAttribute('src')
  imagePreview.hidden = true
  imageInput.value = ''
  if (clearStatus) imageStatus.textContent = ''
  updateSendButton()
}

function decodeWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('image decode failed'))
    }
    image.src = objectUrl
  })
}

async function decodeImage(file) {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file)
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() }
    } catch {
      // Some mobile browsers expose createImageBitmap but cannot decode every
      // supported file type; fall through to the native Image decoder.
    }
  }
  return decodeWithImageElement(file)
}

async function normalizeImage(file) {
  if (!file || !ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error('unsupported image type')
  const decoded = await decodeImage(file)
  try {
    if (!decoded.width || !decoded.height) throw new Error('invalid image dimensions')
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas unavailable')
    context.drawImage(decoded.source, 0, 0, width, height)

    let dataUrl = canvas.toDataURL('image/webp', IMAGE_QUALITY)
    if (!dataUrl.startsWith('data:image/webp;base64,')) dataUrl = canvas.toDataURL('image/jpeg', IMAGE_QUALITY)
    if (!/^data:image\/(?:jpeg|webp);base64,/u.test(dataUrl)) throw new Error('image export failed')
    if (new TextEncoder().encode(dataUrl).byteLength > MAX_IMAGE_DATA_URL_BYTES) throw new Error('image too large')
    return dataUrl
  } finally {
    decoded.close?.()
  }
}

async function chooseImage() {
  const file = imageInput.files?.[0]
  if (!file) return
  clearImageSelection({ clearStatus: false })
  imageProcessing = true
  imageButton.disabled = true
  imageStatus.textContent = '图片处理中……'
  updateSendButton()
  try {
    const dataUrl = await normalizeImage(file)
    selectedImage = { dataUrl }
    imageThumbnail.src = dataUrl
    imagePreview.hidden = false
    imageStatus.textContent = '已选择一张图片'
  } catch {
    clearImageSelection({ clearStatus: false })
    imageStatus.textContent = '这张图片花花暂时看不了，再换一张试试吧。'
  } finally {
    imageProcessing = false
    imageButton.disabled = false
    updateSendButton()
  }
}

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
imageButton.addEventListener('click', () => imageInput.click())
imageInput.addEventListener('change', () => { void chooseImage() })
removeImage.addEventListener('click', () => clearImageSelection())
input.addEventListener('input', updateSendButton)

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
  if (imageProcessing) return
  const message = input.value.trim()
  const image = selectedImage ? { dataUrl: selectedImage.dataUrl } : null
  if (!message && !image) return

  input.value = ''
  input.disabled = true
  imageButton.disabled = true
  sendButton.disabled = true
  line('user', message || '[图片]')
  try {
    const body = { message }
    if (image) body.image = image
    const response = await fetch('/api/pet/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result?.error || 'chat unavailable')
    line('pet', result?.ok ? result.text : (result?.petLine || '花花脑袋刚刚卡了一下……'))
  } catch { line('pet', '花花脑袋刚刚卡了一下……'); setOnline(false) } finally {
    input.disabled = false
    imageButton.disabled = false
    clearImageSelection()
    input.focus()
    updateSendButton()
    refresh()
  }
})

updateSendButton()
refresh(); setInterval(refresh, 1500)
