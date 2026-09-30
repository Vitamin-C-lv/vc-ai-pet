import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { VisualEmbeddingClient } from '../src/vision/visual-embedding-client.js'
import { VisualSemanticIndex } from '../src/vision/visual-semantic-index.js'
import { VisualExperienceStore, VISUAL_EXPERIENCE_DB_FILENAME } from '../src/vision/visual-experience-store.js'

const CONVERSATION_STORE_FILENAME = 'conversation-store.json'
const CONVERSATION_ASSETS_DIR = 'conversation-assets'
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const DEFAULT_BATCH_SIZE = 8

function assetPath(root, value) {
  const relativePath = String(value ?? '')
  if (!relativePath.startsWith(`${CONVERSATION_ASSETS_DIR}/`) || relativePath.includes('..') || isAbsolute(relativePath)) {
    throw new Error('PET_VISUAL_SEMANTIC_ASSET_PATH_INVALID')
  }
  return join(root, relativePath)
}

export async function createReadOnlyAttachmentStore(sandboxRoot) {
  const root = resolve(sandboxRoot)
  const state = JSON.parse(await readFile(join(root, CONVERSATION_STORE_FILENAME), 'utf8'))
  const attachments = new Map((Array.isArray(state?.attachments) ? state.attachments : [])
    .filter((attachment) => attachment && typeof attachment.id === 'string')
    .map((attachment) => [attachment.id, attachment]))
  let fileReads = 0

  return {
    get fileReads() { return fileReads },
    async readAttachmentDataUrl(id, { thumbnail = false } = {}) {
      const attachment = attachments.get(String(id ?? '').trim())
      if (!attachment) return null
      const relativePath = thumbnail ? attachment.thumbnailPath : attachment.assetPath
      const bytes = await readFile(assetPath(root, relativePath))
      fileReads += 1
      const storedMimeType = thumbnail
        ? attachment.thumbnailOriginalMimeType ?? attachment.thumbnailMimeType
        : attachment.originalMimeType ?? attachment.mimeType
      const mimeType = IMAGE_MIME_TYPES.has(storedMimeType) ? storedMimeType : 'image/webp'
      return { dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, attachment }
    },
  }
}

export async function runVisualSemanticIndex({ sandboxRoot, client = new VisualEmbeddingClient(), batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (!sandboxRoot) throw new TypeError('PET_VISUAL_SEMANTIC_SANDBOX_ROOT_REQUIRED')
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new TypeError('PET_VISUAL_SEMANTIC_BATCH_SIZE_INVALID')
  }
  const startedAt = performance.now()
  const root = resolve(sandboxRoot)
  await access(join(root, VISUAL_EXPERIENCE_DB_FILENAME))
  const conversationStore = await createReadOnlyAttachmentStore(root)
  const experienceStore = new VisualExperienceStore(root)
  const index = new VisualSemanticIndex({ experienceStore, conversationStore, client })
  let indexed = 0
  let scanned = 0
  let skipped = 0
  let batches = 0

  try {
    await experienceStore.initialize()
    while (true) {
      const result = await index.sync({ limit: batchSize })
      if (result.scanned === 0) break
      indexed += result.indexed
      scanned += result.scanned
      skipped += result.skipped
      batches += 1
    }
    return { indexed, scanned, skipped, batches, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)) }
  } finally {
    index.stop()
    experienceStore.close()
  }
}

function sandboxRootArgument(args) {
  if (args.length !== 2 || args[0] !== '--sandbox-root' || !args[1] || args[1].startsWith('--')) {
    throw new Error('USAGE')
  }
  return args[1]
}

async function main() {
  const summary = await runVisualSemanticIndex({ sandboxRoot: sandboxRootArgument(process.argv.slice(2)) })
  console.log(JSON.stringify(summary))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    console.error('VISUAL_SEMANTIC_INDEX=FAILED')
    process.exitCode = 1
  })
}
