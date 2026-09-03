export const VISION_ONLY_MESSAGE = '主人给花花看了一张图片。'
export const SUPPORTED_VISION_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'])
export const MAX_IMAGE_DATA_URL_BYTES = 7 * 1024 * 1024

const SUPPORTED_TYPES = new Set(SUPPORTED_VISION_IMAGE_TYPES)
const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u

function invalidImage(message = 'invalid image') {
  const error = new Error(message)
  error.code = 'PET_INVALID_VISION_IMAGE'
  return error
}

/**
 * Validate the small image DTO shared by the LAN boundary and Local Brain
 * adapter. The bytes are never written to Pet state or Memory.
 */
export function normalizeVisionImage(image) {
  if (image === undefined || image === null) return null
  if (typeof image !== 'object' || Array.isArray(image)) throw invalidImage()

  const keys = Object.keys(image)
  if (keys.some((key) => key !== 'dataUrl')) throw invalidImage()

  const dataUrl = image.dataUrl
  if (typeof dataUrl !== 'string') throw invalidImage()
  const match = DATA_URL_PATTERN.exec(dataUrl)
  if (!match || !SUPPORTED_TYPES.has(match[1])) throw invalidImage()
  if (Buffer.byteLength(dataUrl, 'utf8') > MAX_IMAGE_DATA_URL_BYTES) throw invalidImage()

  return { dataUrl }
}
