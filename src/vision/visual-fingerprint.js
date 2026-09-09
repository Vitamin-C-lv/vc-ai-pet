import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

export const STRICT_PHASH_DISTANCE_MAX = 1
export const STRICT_DHASH_DISTANCE_MAX = 1
export const STRICT_ASPECT_RATIO_DELTA_MAX = 0.005

// Keep the original exports as the strict-gate compatibility names.
export const PHASH_DISTANCE_MAX = STRICT_PHASH_DISTANCE_MAX
export const DHASH_DISTANCE_MAX = STRICT_DHASH_DISTANCE_MAX
export const ASPECT_RATIO_DELTA_MAX = STRICT_ASPECT_RATIO_DELTA_MAX

export const RESIZE_SAFE_PHASH_DISTANCE_MAX = 2
export const RESIZE_SAFE_DHASH_DISTANCE_MAX = 1
export const RESIZE_SAFE_ASPECT_RATIO_DELTA_MAX = 0.001

const PHASH_SIZE = 32
const DHASH_WIDTH = 9
const DHASH_HEIGHT = 8

function positiveDimension(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function normalizedBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

function runFfmpeg(bytes, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vf', `scale=${PHASH_SIZE}:${PHASH_SIZE}:flags=area,format=gray`,
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    const output = []
    const errors = []
    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      const pixels = Buffer.concat(output)
      if (code !== 0 || pixels.length !== PHASH_SIZE * PHASH_SIZE) {
        const error = new Error('VISUAL_FINGERPRINT_IMAGE_DECODE_FAILED')
        error.code = 'VISUAL_FINGERPRINT_IMAGE_DECODE_FAILED'
        error.detail = Buffer.concat(errors).toString('utf8').trim().slice(0, 240)
        reject(error)
        return
      }
      resolve(pixels)
    })
    child.stdin.once('error', () => {})
    child.stdin.end(bytes)
  })
}

function dctLowFrequency(pixels) {
  const coefficients = []
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      let sum = 0
      for (let y = 0; y < PHASH_SIZE; y += 1) {
        for (let x = 0; x < PHASH_SIZE; x += 1) {
          sum += pixels[y * PHASH_SIZE + x]
            * Math.cos(((2 * x + 1) * column * Math.PI) / (2 * PHASH_SIZE))
            * Math.cos(((2 * y + 1) * row * Math.PI) / (2 * PHASH_SIZE))
        }
      }
      const rowScale = row === 0 ? 1 / Math.sqrt(2) : 1
      const columnScale = column === 0 ? 1 / Math.sqrt(2) : 1
      coefficients.push(sum * rowScale * columnScale)
    }
  }
  return coefficients
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function toHash(values, predicate) {
  let bits = 0n
  for (const value of values) bits = (bits << 1n) | (predicate(value) ? 1n : 0n)
  return bits.toString(16).padStart(16, '0')
}

function phash(pixels) {
  const coefficients = dctLowFrequency(pixels)
  const threshold = median(coefficients.slice(1))
  return toHash(coefficients, (value) => value > threshold)
}

function averagedResize(pixels, width, height) {
  const resized = []
  for (let y = 0; y < height; y += 1) {
    const sourceTop = Math.floor((y * PHASH_SIZE) / height)
    const sourceBottom = Math.max(sourceTop + 1, Math.floor(((y + 1) * PHASH_SIZE) / height))
    for (let x = 0; x < width; x += 1) {
      const sourceLeft = Math.floor((x * PHASH_SIZE) / width)
      const sourceRight = Math.max(sourceLeft + 1, Math.floor(((x + 1) * PHASH_SIZE) / width))
      let sum = 0
      let count = 0
      for (let sourceY = sourceTop; sourceY < sourceBottom; sourceY += 1) {
        for (let sourceX = sourceLeft; sourceX < sourceRight; sourceX += 1) {
          sum += pixels[sourceY * PHASH_SIZE + sourceX]
          count += 1
        }
      }
      resized.push(sum / Math.max(1, count))
    }
  }
  return resized
}

function dhash(pixels) {
  const resized = averagedResize(pixels, DHASH_WIDTH, DHASH_HEIGHT)
  const comparisons = []
  for (let y = 0; y < DHASH_HEIGHT; y += 1) {
    for (let x = 0; x < DHASH_WIDTH - 1; x += 1) {
      comparisons.push(resized[y * DHASH_WIDTH + x] < resized[y * DHASH_WIDTH + x + 1])
    }
  }
  return toHash(comparisons, Boolean)
}

export function parseImageDataUrl(value) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(String(value ?? ''))
  if (!match) return null
  const bytes = Buffer.from(match[2], 'base64')
  return bytes.length > 0 ? { bytes, mimeType: match[1] } : null
}

export function aspectRatio(width, height) {
  const normalizedWidth = positiveDimension(width)
  const normalizedHeight = positiveDimension(height)
  return normalizedWidth && normalizedHeight ? normalizedWidth / normalizedHeight : null
}

export function hammingDistance(left, right) {
  const a = String(left ?? '').trim().toLowerCase()
  const b = String(right ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{16}$/u.test(a) || !/^[0-9a-f]{16}$/u.test(b)) return null
  let distance = 0
  for (let index = 0; index < a.length; index += 1) {
    let value = Number.parseInt(a[index], 16) ^ Number.parseInt(b[index], 16)
    while (value) {
      distance += value & 1
      value >>>= 1
    }
  }
  return distance
}

export function isStrictNearDuplicate(left, right, {
  phashDistanceMax = PHASH_DISTANCE_MAX,
  dhashDistanceMax = DHASH_DISTANCE_MAX,
  aspectRatioDeltaMax = ASPECT_RATIO_DELTA_MAX,
} = {}) {
  const leftRatio = aspectRatio(left?.width, left?.height)
  const rightRatio = aspectRatio(right?.width, right?.height)
  const phashDistance = hammingDistance(left?.phash, right?.phash)
  const dhashDistance = hammingDistance(left?.dhash, right?.dhash)
  const ratioDelta = leftRatio === null || rightRatio === null ? null : Math.abs(leftRatio - rightRatio)
  return {
    match: ratioDelta !== null
      && phashDistance !== null
      && dhashDistance !== null
      && ratioDelta <= aspectRatioDeltaMax
      && phashDistance <= phashDistanceMax
      && dhashDistance <= dhashDistanceMax,
    phashDistance,
    dhashDistance,
    aspectRatioDelta: ratioDelta,
  }
}

export function isPerceptualNearDuplicate(left, right) {
  const strict = isStrictNearDuplicate(left, right)
  if (strict.match) return { ...strict, perceptualGate: 'strict' }

  const resizeSafe = isStrictNearDuplicate(left, right, {
    phashDistanceMax: RESIZE_SAFE_PHASH_DISTANCE_MAX,
    dhashDistanceMax: RESIZE_SAFE_DHASH_DISTANCE_MAX,
    aspectRatioDeltaMax: RESIZE_SAFE_ASPECT_RATIO_DELTA_MAX,
  })
  return {
    ...resizeSafe,
    perceptualGate: resizeSafe.match ? 'resize-safe' : null,
  }
}

export async function fingerprintImage({ bytes, width = null, height = null, ffmpegPath = process.env.VC_AI_PET_FFMPEG_PATH || 'ffmpeg' } = {}) {
  const normalized = normalizedBytes(bytes)
  if (!normalized || normalized.length === 0) {
    return { sha256: null, phash: null, dhash: null, width: positiveDimension(width), height: positiveDimension(height), decoded: false }
  }

  const result = {
    sha256: createHash('sha256').update(normalized).digest('hex'),
    phash: null,
    dhash: null,
    width: positiveDimension(width),
    height: positiveDimension(height),
    decoded: false,
  }
  try {
    const pixels = await runFfmpeg(normalized, ffmpegPath)
    result.phash = phash(pixels)
    result.dhash = dhash(pixels)
    result.decoded = true
  } catch {
    // Exact SHA-256 remains useful when the optional local decoder cannot read
    // a legacy or malformed attachment. Perceptual matching stays fail-closed.
  }
  return result
}
