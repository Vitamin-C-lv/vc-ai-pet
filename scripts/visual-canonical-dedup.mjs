import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { visualTermsFor } from '../src/vision/visual-keywords.js'
import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

function usage() {
  console.error('用法：node scripts/visual-canonical-dedup.mjs --sandbox <sandbox-root> [--apply]')
  process.exitCode = 2
}

function groupClass(group) {
  const gates = new Set(group.aliases.map((alias) => alias.perceptualGate).filter(Boolean))
  if (gates.has('resize-safe')) return 'resize-safe'
  if (gates.has('strict')) return 'strict'
  return 'exact'
}

const sourceRoot = argument('--sandbox')
const apply = process.argv.includes('--apply')
if (!sourceRoot) {
  usage()
} else {
  const inputRoot = resolve(sourceRoot)
  const preview = !apply
  const workingRoot = preview
    ? await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-canonical-preview-'))
    : inputRoot
  let conversation = null
  let visual = null
  try {
    if (preview) await cp(inputRoot, workingRoot, { recursive: true, force: true })
    conversation = new ConversationStore(workingRoot)
    await conversation.initialize()
    visual = new VisualExperienceStore(workingRoot)
    await visual.initialize()
    const result = await visual.migrateHistorical({
      readAttachment: (attachmentId) => conversation.readAttachmentDataUrl(attachmentId),
      tokenizeText: (text, { boost }) => visualTermsFor(text, { boost }),
    })
    console.log(`MIGRATION_MODE=${preview ? 'PREVIEW' : 'APPLY'}`)
    console.log(`PRODUCTION_DB_MODIFIED=${preview ? 'NO' : 'REVIEW_REQUIRED'}`)
    console.log(`ROOTS_BEFORE=${result.rootsBefore}`)
    console.log(`DUPLICATE_GROUPS=${result.duplicateGroups.length}`)
    console.log(`ROOTS_AFTER_CANONICAL_VIEW=${result.rootsAfterCanonicalView}`)
    console.log(`ALIASES_CREATED=${result.aliasesCreated}`)
    console.log(`OCCURRENCES_CREATED=${result.occurrencesCreated}`)
    console.log(`NEW_ROOT=${result.newRoot}`)
    console.log(`FINGERPRINT_FAILURES=${result.fingerprintFailures}`)
    console.log(`MODEL_CALLS=${result.modelCalls}`)
    console.log(`PET_MEMORY_WRITES=${result.petMemoryWrites}`)
    console.log(`DREAM_RUNS=${result.dreamRuns}`)
    console.log(`EXACT_GROUPS=${result.duplicateGroups.filter((group) => groupClass(group) === 'exact').length}`)
    console.log(`STRICT_PERCEPTUAL_GROUPS=${result.duplicateGroups.filter((group) => groupClass(group) === 'strict').length}`)
    console.log(`RESIZE_SAFE_PERCEPTUAL_GROUPS=${result.duplicateGroups.filter((group) => groupClass(group) === 'resize-safe').length}`)
    for (const gate of [...new Set(result.duplicateGroups.flatMap((group) => group.aliases.map((alias) => alias.perceptualGate).filter(Boolean)))].sort()) {
      console.log(`PERCEPTUAL_GATE=${gate}`)
    }
    console.log(`DUPLICATE_GROUP_DETAILS=${JSON.stringify(result.duplicateGroups)}`)
  } finally {
    try { visual?.close() } catch {}
    try { conversation?.close() } catch {}
    if (preview) await rm(workingRoot, { recursive: true, force: true })
  }
}
