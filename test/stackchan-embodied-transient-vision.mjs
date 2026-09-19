import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { collectRecentVisualCandidates, buildVisualCandidatePool, RecentVisualResolver } from '../src/conversation/recent-visual-context.js'
import { readVisualGallery, readVisualGalleryDetail } from '../src/remote/visual-gallery.js'
import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'
import { allowsLongTermVisualMemory, embodiedTransientExperienceMetadata, STACKCHAN_CAMERA_PROMPT } from '../src/vision/visual-source.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-transient-'))
  const conversation = await new ConversationStore(join(root, 'conversation'), { idFactory: (() => { let n = 0; return () => `attachment-${++n}` })() }).initialize()
  const visual = await new VisualExperienceStore(join(root, 'visual')).initialize()
  return { root, conversation, visual }
}

test('StackChan embodied_transient semantics stay isolated from normal uploads', async (t) => {
  const { root, conversation, visual } = await fixture()
  let activeVisual = visual
  t.after(async () => {
    activeVisual.close()
    conversation.close()
    await rm(root, { recursive: true, force: true })
  })

  const ordinary = await conversation.saveAttachment({ image: PNG, thumbnail: PNG, requireThumbnail: true })
  const embodied = await conversation.saveAttachment({
    image: PNG,
    thumbnail: PNG,
    requireThumbnail: true,
    source: 'stackchan_camera',
    visualClass: 'embodied_transient',
  })

  const ordinaryMessage = await conversation.appendMessage({ role: 'user', text: '这张普通图片里有什么？', attachment: ordinary })
  const embodiedMessage = await conversation.appendMessage({
    role: 'user',
    text: STACKCHAN_CAMERA_PROMPT,
    attachment: embodied,
    source: 'stackchan_camera',
  })

  const visibleHistory = await conversation.history(10)
  assert.equal(visibleHistory.some((item) => item.attachment?.id === embodied.id), true, 'CURRENT_CHAT_IMAGE_VISIBLE=YES')
  assert.equal((await conversation.attachment(embodied.id)).visualClass, 'embodied_transient', 'attachment metadata persisted')

  const ordinaryCandidates = collectRecentVisualCandidates([ordinaryMessage])
  assert.equal(ordinaryCandidates.length, 1, 'CASE 1/8 normal upload remains a recent candidate')
  assert.equal(collectRecentVisualCandidates([embodiedMessage]).length, 0, 'CASE 6 transient image is filtered at candidate collection')

  const currentPool = buildVisualCandidatePool({ currentAttachment: embodied, userText: '请直接告诉我你看到了什么' })
  assert.deepEqual(currentPool.map((item) => item.attachmentId), [embodied.id], 'CASE 3 current turn still receives the image')

  const resolver = new RecentVisualResolver()
  assert.equal(resolver.resolve('刚才那张图里有什么？', [embodiedMessage]).matched, false, 'CASE 6 RECENT_VISUAL_MATERIALIZED=0')
  assert.equal(resolver.resolve('刚才那张图里有什么？', [ordinaryMessage]).matched, true, 'CASE 1/8 normal visual recall remains enabled')

  const transientSync = await visual.syncMessage(embodiedMessage, {
    readAttachment: (id) => conversation.readAttachmentDataUrl(id),
  })
  const ordinarySync = await visual.syncMessage(ordinaryMessage, {
    readAttachment: (id) => conversation.readAttachmentDataUrl(id),
  })
  assert.equal(transientSync.skippedTransient, true, 'CASE 4 perceptual/Gallery pipeline is skipped')
  assert.equal(await visual.countRawRoots(), 1, 'CASE 5 only the ordinary image gets a Visual Memory root')
  assert.equal(ordinarySync.createdExperience, true, 'CASE 1 ordinary image remains Gallery-visible')
  assert.equal(await visual.findExperienceByAttachmentId(embodied.id), null, 'CASE 6 transient root cannot be materialized')
  assert.equal((await visual.listExperiences()).some((item) => item.attachmentId === embodied.id), false, 'CASE 6 transient root is absent from the Gallery source')
  const galleryRuntime = { visualExperience: visual, conversationStore: conversation }
  const gallery = await readVisualGallery(galleryRuntime, { limit: 10 })
  assert.equal(gallery.items.some((item) => item.attachmentId === ordinary.id), true, 'CASE 1 normal upload remains Gallery-visible')
  assert.equal(gallery.items.some((item) => item.attachmentId === embodied.id), false, 'CASE 6 transient upload is absent from Gallery')
  assert.equal(await readVisualGalleryDetail(galleryRuntime, ordinarySync.experienceId) !== null, true, 'CASE 1 normal Gallery detail remains available')
  assert.equal(await readVisualGalleryDetail(galleryRuntime, embodied.id), null, 'CASE 6 transient Gallery detail is unavailable')

  visual.close()
  activeVisual = await new VisualExperienceStore(join(root, 'visual')).initialize()
  assert.equal(await activeVisual.findExperienceByAttachmentId(embodied.id), null, 'CASE 7 transient quarantine survives a restart')
  assert.equal((await activeVisual.listExperiences()).some((item) => item.attachmentId === embodied.id), false, 'CASE 7 restarted Gallery source remains clean')

  assert.equal(allowsLongTermVisualMemory(await conversation.attachment(embodied.id)), false, 'VISUAL_MEMORY_ROOT=NO')
  assert.equal(allowsLongTermVisualMemory(await conversation.attachment(ordinary.id)), true, 'ordinary visual memory remains allowed')

  const event = embodiedTransientExperienceMetadata(1)
  assert.equal(event.sourceType, 'embodied_visual_observation', 'CASE 8 EXPERIENCE_EVENT=YES')
  assert.equal(event.importanceScore < 0.8, true, 'CASE 8 STACKCHAN_MEMORY_WEIGHT=LOW')
  assert.equal(event.attachmentId, null, 'CASE 8 raw_image_as_memory_source=NO')
  assert.equal(event.rawImageAsMemorySource, false)
})
