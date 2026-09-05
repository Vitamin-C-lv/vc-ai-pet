import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { normalizeConversationReasoning } from './reasoning-metadata.js'

export const CONVERSATION_HISTORY_LIMIT = 50
export const CONVERSATION_MAX_MESSAGES = 500
export const CONVERSATION_MAX_IMAGE_EDGE = 1920
export const CONVERSATION_THUMBNAIL_MAX_EDGE = 256
export const CONVERSATION_MAX_IMAGE_DATA_URL_BYTES = 7 * 1024 * 1024
export const CONVERSATION_ASSETS_DIR = 'conversation-assets'
export const CONVERSATION_STORE_FILENAME = 'conversation-store.json'

const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MESSAGE_KINDS = new Set(['dialogue', 'activity', 'media_ref', 'final'])
const ACTIVITY_TYPES = new Set(['turn_started', 'thinking', 'visual_selected', 'visual_image', 'visual_observation', 'visual_compare', 'memory_recall', 'assistant_message', 'turn_completed', 'turn_failed'])
const MESSAGE_PROVENANCE = new Set(['confirmed', 'inferred'])
const IMAGE_EXTENSION_BY_MIME = Object.freeze({
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
})
const WEBP_RIFF_HEADER = Buffer.from('RIFF')
const WEBP_HEADER = Buffer.from('WEBP')
const EMPTY_STATE = Object.freeze({ version: 1, messages: [], attachments: [] })

function storeError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function finiteTimestamp(value, fallback) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback
}

function cleanText(value, maxLength = 1200) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function cleanId(value) {
  const id = String(value ?? '').trim()
  return /^[a-z0-9_-]{1,80}$/iu.test(id) ? id : null
}

function normalizeMessageKind(value) {
  if (value === undefined || value === null || value === 'dialogue') return 'dialogue'
  return MESSAGE_KINDS.has(value) ? value : 'activity'
}

function cleanActivityType(value) {
  return ACTIVITY_TYPES.has(value) ? value : null
}

function cleanRelation(value) {
  return value === 'current' || value === 'previous' ? value : null
}

function cleanProvenance(value) {
  return MESSAGE_PROVENANCE.has(value) ? value : null
}

function cleanActivitySeq(value) {
  const sequence = Number(value)
  return Number.isInteger(sequence) && sequence >= 1 ? sequence : null
}

function cleanActivityAt(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null
}

function imageDimension(value, label) {
  if (value === null || value === undefined || value === '') return null
  const dimension = Number(value)
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw storeError('PET_CONVERSATION_IMAGE_DIMENSIONS_INVALID', `${label} must be a positive integer`)
  }
  return dimension
}

function assertImageEdge(width, height, maxEdge, errorCode) {
  if (width !== null && height !== null && Math.max(width, height) > maxEdge) {
    throw storeError(errorCode)
  }
}

function parseDataUrl(value, { maxBytes = CONVERSATION_MAX_IMAGE_DATA_URL_BYTES } = {}) {
  const dataUrl = typeof value === 'string' ? value : value?.dataUrl
  if (typeof dataUrl !== 'string') throw storeError('PET_CONVERSATION_IMAGE_INVALID')
  if (Buffer.byteLength(dataUrl, 'utf8') > maxBytes) throw storeError('PET_CONVERSATION_IMAGE_TOO_LARGE')

  const match = DATA_URL_PATTERN.exec(dataUrl)
  if (!match || !IMAGE_TYPES.has(match[1])) throw storeError('PET_CONVERSATION_IMAGE_INVALID')

  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0) throw storeError('PET_CONVERSATION_IMAGE_INVALID')
  return { dataUrl, mimeType: match[1], bytes }
}

function imageExtension(mimeType) {
  const extension = IMAGE_EXTENSION_BY_MIME[mimeType]
  if (!extension) throw storeError('PET_CONVERSATION_IMAGE_INVALID')
  return extension
}

function readPngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function readJpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]
    if (marker === 0xd8 || marker === 0xd9) continue
    if (offset + 1 >= bytes.length) return null
    const segmentLength = bytes.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null

    const isStartOfFrame = (
      marker >= 0xc0 && marker <= 0xc3
      || marker >= 0xc5 && marker <= 0xc7
      || marker >= 0xc9 && marker <= 0xcb
      || marker >= 0xcd && marker <= 0xcf
    )
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      }
    }
    offset += segmentLength
  }
  return null
}

function readWebpDimensions(bytes) {
  if (bytes.length < 16 || !bytes.subarray(0, 4).equals(WEBP_RIFF_HEADER) || !bytes.subarray(8, 12).equals(WEBP_HEADER)) return null

  let offset = 12
  while (offset + 8 <= bytes.length) {
    const chunk = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + size > bytes.length) return null

    if (chunk === 'VP8X' && size >= 10) {
      return {
        width: 1 + bytes.readUIntLE(body + 4, 3),
        height: 1 + bytes.readUIntLE(body + 7, 3),
      }
    }

    if (chunk === 'VP8L' && size >= 5 && bytes[body] === 0x2f) {
      const bits = bytes.readUInt32LE(body + 1)
      return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      }
    }

    if (chunk === 'VP8 ' && size >= 10) {
      for (let index = body; index + 9 < body + size; index += 1) {
        if (bytes[index] === 0x9d && bytes[index + 1] === 0x01 && bytes[index + 2] === 0x2a) {
          return {
            width: bytes.readUInt16LE(index + 3) & 0x3fff,
            height: bytes.readUInt16LE(index + 5) & 0x3fff,
          }
        }
      }
    }

    offset = body + size + (size % 2)
  }
  return null
}

function readImageDimensions(bytes, mimeType) {
  if (mimeType === 'image/png') return readPngDimensions(bytes)
  if (mimeType === 'image/jpeg') return readJpegDimensions(bytes)
  if (mimeType === 'image/webp') return readWebpDimensions(bytes)
  return null
}

function stripWebpExif(bytes) {
  if (bytes.length < 12 || !bytes.subarray(0, 4).equals(WEBP_RIFF_HEADER) || !bytes.subarray(8, 12).equals(WEBP_HEADER)) return bytes

  const chunks = []
  let offset = 12
  let removed = false
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const end = offset + 8 + size + (size % 2)
    if (end > bytes.length) return bytes
    if (chunkType === 'EXIF') {
      removed = true
    } else {
      chunks.push(bytes.subarray(offset, end))
    }
    offset = end
  }
  if (!removed || offset !== bytes.length) return bytes

  const output = Buffer.concat([bytes.subarray(0, 12), ...chunks])
  output.writeUInt32LE(output.length - 8, 4)
  return output
}

function relativeAssetPath(root, file) {
  return relative(root, file).split(sep).join('/')
}

function assertSafeRelativeAssetPath(value) {
  const path = String(value ?? '')
  if (!path.startsWith(`${CONVERSATION_ASSETS_DIR}/`) || path.includes('..') || path.startsWith('/')) {
    throw storeError('PET_CONVERSATION_ASSET_PATH_INVALID')
  }
  return path
}

function copyAttachmentMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = cleanId(value.id)
  if (!id) return null

  const assetPath = assertSafeRelativeAssetPath(value.assetPath)
  const thumbnailPath = assertSafeRelativeAssetPath(value.thumbnailPath)
  const mimeType = IMAGE_TYPES.has(value.mimeType) ? value.mimeType : 'image/webp'
  const originalMimeType = IMAGE_TYPES.has(value.originalMimeType) ? value.originalMimeType : mimeType
  const thumbnailMimeType = IMAGE_TYPES.has(value.thumbnailMimeType) ? value.thumbnailMimeType : mimeType
  const thumbnailOriginalMimeType = IMAGE_TYPES.has(value.thumbnailOriginalMimeType)
    ? value.thumbnailOriginalMimeType
    : thumbnailMimeType
  return {
    id,
    mimeType,
    originalMimeType,
    thumbnailMimeType,
    thumbnailOriginalMimeType,
    width: imageDimension(value.width, 'width'),
    height: imageDimension(value.height, 'height'),
    thumbnailWidth: imageDimension(value.thumbnailWidth, 'thumbnailWidth'),
    thumbnailHeight: imageDimension(value.thumbnailHeight, 'thumbnailHeight'),
    size: Number.isInteger(Number(value.size)) && Number(value.size) >= 0 ? Number(value.size) : 0,
    thumbnailSize: Number.isInteger(Number(value.thumbnailSize)) && Number(value.thumbnailSize) >= 0 ? Number(value.thumbnailSize) : 0,
    assetPath,
    thumbnailPath,
    createdAt: finiteTimestamp(value.createdAt, 0),
  }
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return clone(EMPTY_STATE)
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(copyAttachmentMetadata).filter(Boolean)
    : []
  const attachmentMap = new Map(attachments.map((attachment) => [attachment.id, attachment]))
  const messages = Array.isArray(value.messages)
    ? value.messages.map((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return null
      const id = cleanId(message.id)
      const role = message.role === 'user' || message.role === 'assistant' ? message.role : null
      if (!id || !role) return null
      const attachment = copyAttachmentMetadata(message.attachment)
      if (attachment) attachmentMap.set(attachment.id, attachment)
      const reasoning = normalizeConversationReasoning(message.reasoning)
      const turnId = cleanId(message.turnId)
      const kind = normalizeMessageKind(message.kind)
      const sourceAttachmentId = cleanId(message.sourceAttachmentId ?? (kind === 'media_ref' ? attachment?.id : null))
      const activityType = cleanActivityType(message.activityType)
      const relation = cleanRelation(message.relation)
      const provenance = cleanProvenance(message.provenance)
      const activitySeq = cleanActivitySeq(message.activitySeq)
      const activityAt = cleanActivityAt(message.activityAt)
      return {
        id,
        role,
        text: cleanText(message.text),
        timestamp: finiteTimestamp(message.timestamp, 0),
        attachment: attachment ? clone(attachment) : null,
        ...(turnId ? { turnId } : {}),
        ...(kind !== 'dialogue' ? { kind } : {}),
        ...(sourceAttachmentId ? { sourceAttachmentId } : {}),
        ...(activityType ? { activityType } : {}),
        ...(relation ? { relation } : {}),
        ...(provenance ? { provenance } : {}),
        ...(activitySeq ? { activitySeq } : {}),
        ...(activityAt !== null ? { activityAt } : {}),
        ...(reasoning ? { reasoning } : {}),
      }
    }).filter(Boolean)
    : []

  return {
    version: 1,
    messages: messages.slice(-CONVERSATION_MAX_MESSAGES),
    attachments: [...attachmentMap.values()],
  }
}

function padDatePart(value) {
  return String(value).padStart(2, '0')
}

function dateParts(timestamp) {
  const date = new Date(timestamp)
  return [
    String(date.getFullYear()),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ]
}

export class ConversationStore {
  constructor(root, {
    now = () => Date.now(),
    idFactory = randomUUID,
    maxMessages = CONVERSATION_MAX_MESSAGES,
  } = {}) {
    if (!root) throw new TypeError('PET_CONVERSATION_STORE_ROOT_REQUIRED')
    if (typeof now !== 'function') throw new TypeError('PET_CONVERSATION_STORE_CLOCK_INVALID')
    if (typeof idFactory !== 'function') throw new TypeError('PET_CONVERSATION_STORE_ID_FACTORY_INVALID')
    if (!Number.isInteger(maxMessages) || maxMessages < CONVERSATION_HISTORY_LIMIT) throw new TypeError('PET_CONVERSATION_STORE_MAX_MESSAGES_INVALID')

    this.root = resolve(root)
    this.storePath = join(this.root, CONVERSATION_STORE_FILENAME)
    this.assetsRoot = join(this.root, CONVERSATION_ASSETS_DIR)
    this.now = now
    this.idFactory = idFactory
    this.maxMessages = maxMessages
    this.state = clone(EMPTY_STATE)
    this.initialized = false
    this.initializing = null
    this.writeQueue = Promise.resolve()
  }

  async initialize() {
    if (this.initialized) return this
    if (this.initializing) return this.initializing

    this.initializing = (async () => {
      await mkdir(this.root, { recursive: true })
      await mkdir(this.assetsRoot, { recursive: true })
      try {
        this.state = normalizeState(JSON.parse(await readFile(this.storePath, 'utf8')))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        this.state = clone(EMPTY_STATE)
        await this.#writeState()
      }
      this.initialized = true
      return this
    })()

    try {
      return await this.initializing
    } finally {
      this.initializing = null
    }
  }

  async list(limit = CONVERSATION_HISTORY_LIMIT) {
    await this.initialize()
    const requested = Number(limit)
    const count = Number.isFinite(requested)
      ? Math.max(0, Math.min(CONVERSATION_HISTORY_LIMIT, requested))
      : CONVERSATION_HISTORY_LIMIT
    return clone(this.state.messages.slice(-count))
  }

  /**
   * Return the persistent message timeline for the Recent Visual Resolver.
   * Unlike the UI history endpoint, this is allowed to inspect all retained
   * messages so ordinary text turns cannot evict older image-bearing turns
   * from the resolver's ten-image window.
   */
  async listForRecentVisualRecall(limit = this.maxMessages) {
    await this.initialize()
    const requested = Number(limit)
    const count = Number.isFinite(requested)
      ? Math.max(0, Math.min(this.maxMessages, Math.floor(requested)))
      : this.maxMessages
    return clone(this.state.messages.slice(-count))
  }

  async history(limit = CONVERSATION_HISTORY_LIMIT) {
    const messages = await this.list(limit)
    return messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      attachment: message.attachment ? this.publicAttachment(message.attachment) : null,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.kind ? { kind: message.kind } : {}),
      ...(message.sourceAttachmentId ? { sourceAttachmentId: message.sourceAttachmentId } : {}),
      ...(message.activityType ? { activityType: message.activityType } : {}),
      ...(message.relation ? { relation: message.relation } : {}),
      ...(message.provenance ? { provenance: message.provenance } : {}),
      ...(message.activitySeq ? { activitySeq: message.activitySeq } : {}),
      ...(message.activityAt !== undefined ? { activityAt: message.activityAt } : {}),
      ...(message.reasoning ? { reasoning: clone(message.reasoning) } : {}),
    }))
  }

  async getHistory(limit = CONVERSATION_HISTORY_LIMIT) {
    return this.history(limit)
  }

  async messages(limit = CONVERSATION_HISTORY_LIMIT) {
    return this.list(limit)
  }

  async semanticHistory(limit = this.maxMessages) {
    const messages = await this.listForRecentVisualRecall(limit)
    const semantic = messages.filter((message) => !['activity', 'media_ref'].includes(message.kind))
    const projected = []
    const finalByTurn = new Map()
    for (const message of semantic) {
      if (message.role !== 'assistant' || message.kind !== 'final' || !message.turnId) {
        projected.push(message)
        continue
      }
      const existing = finalByTurn.get(message.turnId)
      if (!existing) {
        const copy = clone(message)
        finalByTurn.set(message.turnId, copy)
        projected.push(copy)
        continue
      }
      existing.text = [existing.text, message.text].filter(Boolean).join('\n').slice(0, 1200)
      existing.timestamp = message.timestamp
      existing.id = message.id
      if (message.reasoning) existing.reasoning = clone(message.reasoning)
    }
    return projected
  }

  async saveAttachment({ image, thumbnail = null, width = null, height = null, thumbnailWidth = null, thumbnailHeight = null, timestamp = this.now(), requireThumbnail = false } = {}) {
    return this.#enqueue(async () => {
      await this.initialize()
      const asset = parseDataUrl(image)
      const assetDimensions = readImageDimensions(asset.bytes, asset.mimeType)
      const requestedWidth = imageDimension(width, 'width')
      const requestedHeight = imageDimension(height, 'height')
      const requestedThumbnailWidth = imageDimension(thumbnailWidth, 'thumbnailWidth')
      const requestedThumbnailHeight = imageDimension(thumbnailHeight, 'thumbnailHeight')
      const actualWidth = assetDimensions?.width ?? requestedWidth
      const actualHeight = assetDimensions?.height ?? requestedHeight
      assertImageEdge(actualWidth, actualHeight, CONVERSATION_MAX_IMAGE_EDGE, 'PET_CONVERSATION_IMAGE_TOO_LARGE')

      if (requireThumbnail && !thumbnail) throw storeError('PET_CONVERSATION_THUMBNAIL_REQUIRED')
      const thumb = thumbnail ? parseDataUrl(thumbnail, { maxBytes: 2 * 1024 * 1024 }) : asset
      const thumbDimensions = readImageDimensions(thumb.bytes, thumb.mimeType)
      const storedThumbnailWidth = thumbDimensions?.width ?? requestedThumbnailWidth ?? (thumbnail ? Math.min(actualWidth ?? CONVERSATION_THUMBNAIL_MAX_EDGE, CONVERSATION_THUMBNAIL_MAX_EDGE) : actualWidth)
      const storedThumbnailHeight = thumbDimensions?.height ?? requestedThumbnailHeight ?? (thumbnail ? Math.min(actualHeight ?? CONVERSATION_THUMBNAIL_MAX_EDGE, CONVERSATION_THUMBNAIL_MAX_EDGE) : actualHeight)
      assertImageEdge(storedThumbnailWidth, storedThumbnailHeight, CONVERSATION_THUMBNAIL_MAX_EDGE, 'PET_CONVERSATION_THUMBNAIL_TOO_LARGE')

      const createdAt = finiteTimestamp(timestamp, this.now())
      const generatedId = this.idFactory()
      const id = cleanId(generatedId)
      if (!id) throw storeError('PET_CONVERSATION_ID_INVALID')
      const [year, month, day] = dateParts(createdAt)
      const directory = join(this.assetsRoot, year, month, day)
      await mkdir(directory, { recursive: true })

      const assetExtension = imageExtension(asset.mimeType)
      const thumbnailExtension = imageExtension(thumb.mimeType)
      const assetFile = join(directory, `${id}.${assetExtension}`)
      const thumbnailFile = join(directory, `${id}-thumbnail.${thumbnailExtension}`)
      const assetBytes = asset.mimeType === 'image/webp' ? stripWebpExif(asset.bytes) : asset.bytes
      const thumbnailBytes = thumb.mimeType === 'image/webp' ? stripWebpExif(thumb.bytes) : thumb.bytes
      await writeFile(assetFile, assetBytes, { mode: 0o600 })
      await writeFile(thumbnailFile, thumbnailBytes, { mode: 0o600 })

      const metadata = {
        id,
        mimeType: asset.mimeType,
        originalMimeType: asset.mimeType,
        thumbnailMimeType: thumb.mimeType,
        thumbnailOriginalMimeType: thumb.mimeType,
        width: actualWidth,
        height: actualHeight,
        thumbnailWidth: storedThumbnailWidth,
        thumbnailHeight: storedThumbnailHeight,
        size: assetBytes.length,
        thumbnailSize: thumbnailBytes.length,
        assetPath: relativeAssetPath(this.root, assetFile),
        thumbnailPath: relativeAssetPath(this.root, thumbnailFile),
        createdAt,
      }
      this.state.attachments = [
        ...this.state.attachments.filter((item) => item.id !== id),
        metadata,
      ]
      await this.#writeState()
      return clone(metadata)
    })
  }

  async attachment(id) {
    await this.initialize()
    const clean = cleanId(id)
    if (!clean) return null
    const attachment = this.state.attachments.find((item) => item.id === clean)
    return attachment ? clone(attachment) : null
  }

  async readAttachmentDataUrl(id) {
    const attachment = await this.attachment(id)
    if (!attachment) return null
    const assetPath = this.#assetPath(attachment.assetPath)
    const bytes = await readFile(assetPath)
    const mimeType = IMAGE_TYPES.has(attachment.originalMimeType) ? attachment.originalMimeType : 'image/webp'
    return {
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      attachment,
    }
  }

  publicAttachment(attachment) {
    const value = copyAttachmentMetadata(attachment)
    if (!value) return null
    const encode = (path) => `/${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`
    return {
      id: value.id,
      mimeType: value.mimeType,
      width: value.width,
      height: value.height,
      thumbnailWidth: value.thumbnailWidth,
      thumbnailHeight: value.thumbnailHeight,
      size: value.size,
      thumbnailSize: value.thumbnailSize,
      assetUrl: encode(value.assetPath),
      thumbnailUrl: encode(value.thumbnailPath),
    }
  }

  async appendMessage({ id = null, role, text = '', timestamp = this.now(), attachment = null, reasoning = null, turnId = null, kind = 'dialogue', sourceAttachmentId = null, activityType = null, relation = null, provenance = null, activitySeq = null, activityAt = null } = {}) {
    return this.#enqueue(async () => {
      await this.initialize()
      if (role !== 'user' && role !== 'assistant') throw storeError('PET_CONVERSATION_ROLE_INVALID')
      const messageId = cleanId(id) ?? this.idFactory()
      const normalizedAttachment = attachment ? copyAttachmentMetadata(attachment) : null
      if (attachment && !normalizedAttachment) throw storeError('PET_CONVERSATION_ATTACHMENT_INVALID')
      const normalizedReasoning = normalizeConversationReasoning(reasoning)
      const normalizedTurnId = cleanId(turnId)
      const normalizedKind = normalizeMessageKind(kind)
      const normalizedSourceAttachmentId = cleanId(sourceAttachmentId ?? (normalizedKind === 'media_ref' ? normalizedAttachment?.id : null))
      const referencedAttachment = normalizedSourceAttachmentId
        ? this.state.attachments.find((item) => item.id === normalizedSourceAttachmentId) ?? null
        : null
      if (normalizedKind === 'media_ref' && (!normalizedSourceAttachmentId || !this.state.attachments.some((item) => item.id === normalizedSourceAttachmentId) || (normalizedAttachment && normalizedAttachment.id !== normalizedSourceAttachmentId))) throw storeError('PET_CONVERSATION_MEDIA_REF_SOURCE_INVALID')
      const messageAttachment = normalizedAttachment ?? referencedAttachment
      if (messageAttachment && !this.state.attachments.some((item) => item.id === messageAttachment.id)) {
        this.state.attachments.push(messageAttachment)
      }
      const normalizedActivityType = cleanActivityType(activityType)
      const normalizedRelation = cleanRelation(relation)
      const normalizedProvenance = cleanProvenance(provenance)
      const normalizedActivitySeq = cleanActivitySeq(activitySeq)
      const normalizedActivityAt = cleanActivityAt(activityAt)

      const message = {
        id: messageId,
        role,
        text: cleanText(text),
        timestamp: finiteTimestamp(timestamp, this.now()),
        attachment: messageAttachment,
        ...(normalizedTurnId ? { turnId: normalizedTurnId } : {}),
        ...(normalizedKind !== 'dialogue' ? { kind: normalizedKind } : {}),
        ...(normalizedSourceAttachmentId ? { sourceAttachmentId: normalizedSourceAttachmentId } : {}),
        ...(normalizedActivityType ? { activityType: normalizedActivityType } : {}),
        ...(normalizedRelation ? { relation: normalizedRelation } : {}),
        ...(normalizedProvenance ? { provenance: normalizedProvenance } : {}),
        ...(normalizedActivitySeq ? { activitySeq: normalizedActivitySeq } : {}),
        ...(normalizedActivityAt !== null ? { activityAt: normalizedActivityAt } : {}),
        ...(normalizedReasoning ? { reasoning: normalizedReasoning } : {}),
      }
      this.state.messages.push(message)
      if (this.state.messages.length > this.maxMessages) {
        this.state.messages.splice(0, this.state.messages.length - this.maxMessages)
      }
      await this.#writeState()
      return clone(message)
    })
  }

  async #enqueue(task) {
    const next = this.writeQueue.then(task, task)
    this.writeQueue = next.catch(() => {})
    return next
  }

  #assetPath(relativePath) {
    const safePath = assertSafeRelativeAssetPath(relativePath)
    const target = resolve(this.root, safePath)
    const root = resolve(this.root)
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw storeError('PET_CONVERSATION_ASSET_PATH_INVALID')
    return target
  }

  async #writeState() {
    const temporary = `${this.storePath}.tmp`
    await mkdir(dirname(this.storePath), { recursive: true })
    await writeFile(temporary, JSON.stringify({
      version: 1,
      messages: this.state.messages,
      attachments: this.state.attachments,
    }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.storePath)
  }
}

export function isConversationAttachment(value) {
  return Boolean(copyAttachmentMetadata(value))
}
