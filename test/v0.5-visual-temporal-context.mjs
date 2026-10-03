import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { LocalBrain } from '../src/brain/local-brain.js'
import { formatVisualTimeContext, readVisualUploadTimes } from '../src/brain/visual-time-context.js'
import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'
import { VisualWorkingSession } from '../src/vision/visual-working-session.js'

const SAME_IMAGE = 'data:image/png;base64,QUFB'
const OTHER_IMAGE = 'data:image/png;base64,QkJC'
const FIRST_UPLOAD = Date.UTC(2026, 9, 3, 3, 30)
const SECOND_UPLOAD = FIRST_UPLOAD + 10 * 60_000
const OTHER_UPLOAD = SECOND_UPLOAD + 10 * 60_000
const NOW = OTHER_UPLOAD + 5 * 60_000

async function saveOwnerImage(conversation, image, id, text, timestamp) {
  const attachment = await conversation.saveAttachment({ image: { dataUrl: image }, timestamp })
  await conversation.appendMessage({ id, role: 'user', text, attachment, timestamp })
  return attachment
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-time-'))
  const conversation = new ConversationStore(root, { now: () => NOW })
  const experiences = new VisualExperienceStore(root, { now: () => NOW })
  try {
    await conversation.initialize()
    await experiences.initialize()
    const first = await saveOwnerImage(conversation, SAME_IMAGE, 'upload-1', '太阳出来啦猫猫也在晒太阳', FIRST_UPLOAD)
    const second = await saveOwnerImage(conversation, SAME_IMAGE, 'upload-2', '这张猫猫还是黑莓', SECOND_UPLOAD)
    const unrelated = await saveOwnerImage(conversation, OTHER_IMAGE, 'upload-other', '另一张猫', OTHER_UPLOAD)
    await conversation.appendMessage({
      id: 'assistant-redisplay',
      role: 'assistant',
      kind: 'media_ref',
      activityType: 'visual_image',
      sourceAttachmentId: first.id,
      attachment: first,
      timestamp: OTHER_UPLOAD + 60_000,
      text: '花花重新看看这张',
    })

    await experiences.syncFromArchive({
      readBatch: (afterSequence, limit) => conversation.rawHistoryAfterSequence({ afterSequence, limit }),
      readMaxSequence: () => conversation.rawHistoryMaxSequence(),
      readAttachment: (attachmentId) => conversation.readAttachmentDataUrl(attachmentId),
    })

    const uploadTimes = await readVisualUploadTimes(experiences, first)
    assert.deepEqual(uploadTimes, [FIRST_UPLOAD, SECOND_UPLOAD])
    assert.deepEqual(await readVisualUploadTimes(experiences, unrelated), [OTHER_UPLOAD])
    assert.deepEqual(await readVisualUploadTimes(experiences, { id: 'not-indexed', createdAt: NOW }), [NOW])

    const formatted = formatVisualTimeContext({
      uploadedAt: first.createdAt,
      uploadTimes,
      now: NOW,
      imageRelation: 'recalled',
    })
    assert.ok(formatted.includes('图库或以前对话调取'))
    assert.ok(formatted.includes('已记录主人上传次数：2'))
    assert.ok(formatted.includes(new Date(FIRST_UPLOAD).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })))
    assert.ok(formatted.includes(new Date(SECOND_UPLOAD).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })))
    assert.ok(formatted.includes(new Date(NOW).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })))
    assert.ok(formatted.includes('结合各次上传时间、当前时间和主人原话，自行判断'))

    const requests = []
    const client = {
      async chat(request) {
        requests.push(request)
        const response = request.reasoningStage === 'visual-step'
          ? { action: 'answer', nextVisualId: '', observation: '黑白猫趴在窗边，身上有明暗相间的花纹。', focus: '黑白毛色', replyMessages: ['这张图里是黑莓。'], match: 'match' }
          : { replyMessages: ['这次确认了一张符合要求的照片。'] }
        return { payload: { choices: [{ message: { content: JSON.stringify(response) } }] } }
      },
    }
    const brain = new LocalBrain({ client, memory: null })
    const session = new VisualWorkingSession({
      turnId: 'temporal-summary-turn',
      userText: '太阳出来啦猫猫也在晒太阳，这张就是黑莓',
      recallQuery: '黑莓在晒太阳的照片',
      candidatePool: [{ visualId: 'V0', attachmentId: first.id, relation: 'recalled', userText: '太阳出来啦猫猫也在晒太阳', timestamp: FIRST_UPLOAD }],
      conversationStore: conversation,
      experienceStore: experiences,
      brain,
      emit() {},
      now: () => NOW,
      recallGoal: 'summarize_photos',
      photoCount: 2,
    })
    const result = await session.run('V0')
    assert.equal(result.ok, true)

    const visualPrompt = requests.find((request) => request.reasoningStage === 'visual-step').messages[0].content
    assert.ok(visualPrompt.includes('当前查看来源：从图库或以前对话调取的图片'))
    assert.ok(visualPrompt.includes('这张图片各次上传时间'))
    assert.ok(visualPrompt.includes(new Date(FIRST_UPLOAD).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })))
    assert.ok(visualPrompt.includes(new Date(SECOND_UPLOAD).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })))
    assert.ok(visualPrompt.includes('本图主人原始说明'))

    const summaryPrompt = requests.find((request) => request.reasoningStage === 'visual-summary').messages[0].content
    assert.ok(summaryPrompt.includes('已记录主人上传次数：2'))
    assert.ok(summaryPrompt.includes(new Date(FIRST_UPLOAD).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })))
    assert.ok(summaryPrompt.includes(new Date(SECOND_UPLOAD).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })))
    assert.ok(summaryPrompt.includes('当前查看来源'))

    // The session re-displays this attachment as an assistant media_ref. Only
    // owner-upload occurrences contribute to the list.
    assert.deepEqual(await readVisualUploadTimes(experiences, first), [FIRST_UPLOAD, SECOND_UPLOAD])
    assert.deepEqual(await readVisualUploadTimes(experiences, second), [FIRST_UPLOAD, SECOND_UPLOAD])
    console.log('VISUAL_TEMPORAL_CONTEXT=PASS')
  } finally {
    try { experiences.close() } catch {}
    try { conversation.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

await main()
