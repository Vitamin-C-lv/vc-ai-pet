import {
  cleanVisualText,
  contentQueryTerms,
  visualKeywordTerms,
} from '../vision/visual-keywords.js'
import { isStackchanCameraMessage } from '../vision/visual-source.js'

export const RECENT_VISUAL_MAX_ATTACHMENTS = 10
export const RECENT_VISUAL_WINDOW = '10_IMAGE_MESSAGES'

const LATEST_IMAGE_REFERENCE_PATTERN = /(上一张|前一张|刚才那张|前面那张|最后一张|最新那张|最近那张)/u
// Mentioning a photo is not by itself a request to reopen one. Keep concrete
// references and viewing requests here; historical recall has its own route.
const STRONG_VISUAL_REFERENCE_PATTERN = /(图里|图中|图上|这张图|这张图片|那张图|那张照片|上一张|前一张|刚才那张|前面那张|再看一下|再看看|回看|看看|重新看看|仔细看看|仔细看|看清楚|你再看|图片里面|照片里面|图片上|照片上|画面里|那盆|那碗|那盘|那张)/u
const EXPLICIT_VISUAL_SEARCH_PATTERN = /(?:^找(?!错)|帮我找|给我找|找一下|找出|搜索|检索|翻出|调出|发给我|给我看).*(?:图片|照片|截图|图像)/u
const WEAK_DEICTIC_PATTERN = /(这|这个|这些|它|那个|刚才那个|里面那个)/u
const FOLLOW_UP_PATTERN = /(吗|么|呢|？|\?|是不是|是否|真的吗|真的|什么|哪|怎么|多少|好不好|能不能|可以吗|看起来|看清|仔细|吃|喝|味道|叶子|颜色|画面|内容|是什么|怎么样|如何|像不像|对不对|有没有|好看|漂亮|可爱|不错|真实|真假|应该|感觉)/u
const IMMEDIATE_TEMPORAL_PATTERN = /(刚才|刚刚|刚发的|刚给你看的|这碗|这盘|这个图里|刚才的面|刚才那个)/u
const IMMEDIATE_PREVIOUS_PATTERN = /(刚才|刚刚|刚发的|刚给你看的|刚才的面|刚才那个)/u
const BARE_IMMEDIATE_DEICTIC_PATTERN = /^(?:这个|这张|它|这个图)$/u
const COMPARISON_PATTERN = /(两张|这两个|这两幅|比较|区别|不同|哪里不一样|找不同|对比|相比|上一张和这张|这张和上一张|前一张和这张|这张和前一张)/u
// Gallery requests need contextual model planning before the recent-image
// shortcut, including elliptical requests with no subject in this sentence.
// This selects a route, not a retrieval match or an automatic tool call.
export function needsVisualRecallTaskPlan(userText) {
  const text = String(userText ?? '')
  return /(?:图库|相册)/u.test(text)
    || (/(?:图片|照片)/u.test(text)
      && /(?:总结|归纳|综合|几张|多张|多看|[两二三四五六七八九十\d]+张)/u.test(text))
}
const STANDALONE_PREVIOUS_PATTERN = /^(?:前一张|上一张)$/u
const AMBIGUOUS_DEICTIC_PATTERN = /(之前那个|前面那个|那个怎么样)/u

export function isVisualIdentityStatement(userText) {
  const text = cleanText(userText)
  if (detectVisualRecallCorrection(text)) return false
  // A conversational "就是那个机器人" does not name a displayed photo.
  // Require an image anchor or explicit naming, rather than a bare "那个".
  if (!STRONG_VISUAL_REFERENCE_PATTERN.test(text) && !IMMEDIATE_TEMPORAL_PATTERN.test(text)
    && !/(?:名字|名为|叫|是(?:我们|我|你们|你)家的)/u.test(text)) return false
  return /(?:就是|名字(?:是|叫|为)|名为|叫|是(?:我们|我|你们|你)家的)/u.test(text)
    && (STRONG_VISUAL_REFERENCE_PATTERN.test(text) || IMMEDIATE_TEMPORAL_PATTERN.test(text) || WEAK_DEICTIC_PATTERN.test(text))
    && !/(?:是不是|是否|可能|也许|好像|如果|假如|吗|么|[？?])/u.test(text)
    && (!/(?:不是|不叫)/u.test(text) || /(?:而是|就是|[，,]\s*是)/u.test(text))
}

export function detectVisualRecallCorrection(userText) {
  const text = cleanText(userText)
  if (!/(?:图片|照片|图).{0,8}(?:找错|发错|不对)|(?:找错|发错).{0,8}(?:图片|照片|图)|不是(?:这|那)张|不是[^，,。]{0,30}(?:这|那)张(?:图|照片)/u.test(text)) return null
  const target = text.match(/(?:而是|我说的是|我指的是|[，,]\s*是)\s*([^，,。！？!?]+)[。！？!?]*$/u)?.[1]?.trim()
  return { query: target || null }
}

// Follow the image actually displayed in the conversation, including recalled
// images. Only identity statements and the resulting clarification may bridge
// an intervening text turn; ordinary topics end this association.
function activeVisualAttachment(messages) {
  const source = Array.isArray(messages) ? messages : []
  let end = source.length
  for (let bridges = 0; bridges <= 2; bridges++) {
    let start = end - 1
    while (start >= 0 && source[start]?.role !== 'user') start--
    if (start < 0) return null
    const owner = source[start]
    if (isStackchanCameraMessage(owner)) return null
    const shown = [...new Set(source.slice(start + 1, end)
      .filter((message) => message.role === 'assistant' && message.kind === 'media_ref')
      .map((message) => message.sourceAttachmentId ?? attachmentIdFromMessage(message)).filter(Boolean))]
    if (shown.length > 1) return null
    if (shown.length === 1) return shown[0]
    if (attachmentIdFromMessage(owner)) return attachmentIdFromMessage(owner)
    if (owner.activityType === 'visual_owner_caption' && owner.sourceAttachmentId) return owner.sourceAttachmentId
    const clarification = source.slice(start + 1, end).some((message) => message.role === 'assistant'
      && message.text === '主人说的是哪一张呀？花花怕认错，能再说得具体一点吗？')
    if (!clarification || !isVisualIdentityStatement(owner.text)) return null
    end = start
  }
  return null
}

const cleanText = cleanVisualText

function attachmentIdFromMessage(message) {
  const id = message?.attachment?.id ?? message?.attachmentId
  const clean = String(id ?? '').trim()
  return /^[a-z0-9_-]{1,80}$/iu.test(clean) ? clean : null
}

function timestampOf(message) {
  const timestamp = Number(message?.timestamp)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0
}

/**
 * Build the persistent image-bearing candidates without reading any image
 * bytes. The attachment metadata remains the sole link to the stored asset.
 */
export function collectRecentVisualCandidates(messages = [], maxAttachments = RECENT_VISUAL_MAX_ATTACHMENTS) {
  const source = Array.isArray(messages) ? messages : []
  const requested = Number(maxAttachments)
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.min(RECENT_VISUAL_MAX_ATTACHMENTS, Math.floor(requested)))
    : RECENT_VISUAL_MAX_ATTACHMENTS
  if (limit === 0) return []

  const candidates = []
  source.forEach((message, index) => {
    if (message?.role !== 'user') return
    if (isStackchanCameraMessage(message)) return
    const attachmentId = attachmentIdFromMessage(message)
    if (!attachmentId) return
    candidates.push({
      attachmentId,
      userText: cleanText(message.text ?? message.content),
      timestamp: timestampOf(message),
      messageIndex: index,
    })
  })
  for (const message of source) {
    if (message?.role !== 'user' || message.activityType !== 'visual_owner_caption' || !message.sourceAttachmentId) continue
    for (const candidate of candidates) {
      if (candidate.attachmentId === message.sourceAttachmentId) candidate.userText += `\n${cleanText(message.text)}`
    }
  }
  return candidates.sort((left, right) => left.timestamp - right.timestamp || left.messageIndex - right.messageIndex).slice(-limit)
}

function hasImmediateImage(messages) {
  const users = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'user')
  return Boolean(attachmentIdFromMessage(users.at(-1)))
}

export function detectVisualIntent(userText, { hasCurrent = false, candidateCount = 0 } = {}) {
  const text = cleanText(userText)
  if (!text && hasCurrent) return 'single_inspection'
  if (COMPARISON_PATTERN.test(text) && !STANDALONE_PREVIOUS_PATTERN.test(text)) return candidateCount + (hasCurrent ? 1 : 0) >= 2 ? 'comparison' : 'ambiguous'
  if (AMBIGUOUS_DEICTIC_PATTERN.test(text) && candidateCount > 1) return 'ambiguous'
  const weakImmediateReference = WEAK_DEICTIC_PATTERN.test(text) && FOLLOW_UP_PATTERN.test(text)
  if (hasCurrent && weakImmediateReference && !AMBIGUOUS_DEICTIC_PATTERN.test(text)) return 'single_inspection'
  if (IMMEDIATE_TEMPORAL_PATTERN.test(text) || BARE_IMMEDIATE_DEICTIC_PATTERN.test(text)) return candidateCount || hasCurrent ? 'temporal_followup' : 'ambiguous'
  if (STRONG_VISUAL_REFERENCE_PATTERN.test(text) || EXPLICIT_VISUAL_SEARCH_PATTERN.test(text)) return candidateCount ? 'historical_visual' : hasCurrent ? 'single_inspection' : 'none'
  if (hasCurrent) return 'single_inspection'
  return 'none'
}

export function isImmediatePreviousVisualReference(userText) {
  return IMMEDIATE_PREVIOUS_PATTERN.test(cleanText(userText))
}

export function isExplicitPreviousVisualReference(userText) {
  return /(上一张|前一张|刚才那张|前面那张|之前那张|以前那张|上次那张)/u.test(cleanText(userText))
}

export function isDirectRecentVisualReference(userText, messages = []) {
  const text = cleanText(userText)
  return LATEST_IMAGE_REFERENCE_PATTERN.test(text)
    || (hasImmediateImage(messages) && (
      IMMEDIATE_TEMPORAL_PATTERN.test(text)
      || BARE_IMMEDIATE_DEICTIC_PATTERN.test(text)
      || (WEAK_DEICTIC_PATTERN.test(text) && FOLLOW_UP_PATTERN.test(text))
    ))
}

export function isExplicitVisualSearch(userText) {
  return EXPLICIT_VISUAL_SEARCH_PATTERN.test(cleanText(userText)) || Boolean(detectVisualRecallCorrection(userText))
}

export function buildVisualCandidatePool({ currentAttachment = null, userText = '', messages = [], maxAttachments = RECENT_VISUAL_MAX_ATTACHMENTS } = {}) {
  const historic = collectRecentVisualCandidates(messages, maxAttachments).slice().reverse()
  const candidates = []
  const currentId = attachmentIdFromMessage({ attachment: currentAttachment })
  if (currentId) candidates.push({ visualId: 'V0', attachmentId: currentId, relation: 'current', userText: cleanText(userText), timestamp: Date.now() })
  for (const candidate of historic) {
    if (candidate.attachmentId === currentId) continue
    candidates.push({ ...candidate, visualId: `V${candidates.length}`, relation: 'previous' })
  }
  return candidates.slice(0, RECENT_VISUAL_MAX_ATTACHMENTS + (currentId ? 1 : 0))
}

function newestByScore(query, candidates) {
  const queryTerms = contentQueryTerms(query).filter(({ term }) => term.length >= 2)
  let best = null
  let bestScore = -1
  let secondScore = -1
  for (const candidate of candidates) {
    const candidateTerms = visualKeywordTerms(candidate.userText)
    const score = queryTerms.reduce((total, { term, weight }) =>
      total + (candidateTerms.has(term) ? Math.min(weight, candidateTerms.get(term)) : 0), 0)
    if (score > bestScore) {
      secondScore = bestScore
      best = candidate
      bestScore = score
    } else if (score > secondScore) secondScore = score
  }
  return bestScore > 0 && bestScore > secondScore ? best : null
}

function matched(candidate) {
  return candidate
    ? { matched: true, attachmentId: candidate.attachmentId, reason: 'recent-visual-reference' }
    : { matched: false, attachmentId: null, reason: 'no-recent-visual-candidate' }
}

export class RecentVisualResolver {
  constructor({ maxAttachments = RECENT_VISUAL_MAX_ATTACHMENTS } = {}) {
    if (!Number.isInteger(maxAttachments) || maxAttachments < 1 || maxAttachments > RECENT_VISUAL_MAX_ATTACHMENTS) {
      throw new Error('PET_RECENT_VISUAL_MAX_ATTACHMENTS_INVALID')
    }
    this.maxAttachments = maxAttachments
  }

  resolve(userText, messages = []) {
    if (userText && typeof userText === 'object' && !Array.isArray(userText)) {
      messages = userText.messages ?? []
      userText = userText.userText ?? userText.text ?? ''
    }
    const text = cleanText(userText)
    if (detectVisualRecallCorrection(text)) return matched(null)
    const candidates = collectRecentVisualCandidates(messages, this.maxAttachments)
    if (!text || candidates.length === 0) return matched(null)

    const latest = candidates.at(-1)
    if (isVisualIdentityStatement(text)) {
      const activeId = activeVisualAttachment(messages)
      const active = candidates.find((candidate) => candidate.attachmentId === activeId)
      if (active) return { matched: true, attachmentId: active.attachmentId, reason: 'active-visual-reference' }
      return { matched: false, attachmentId: null, reason: 'ambiguous-visual-reference' }
    }
    if (COMPARISON_PATTERN.test(text) && !STANDALONE_PREVIOUS_PATTERN.test(text)) {
      return candidates.length >= 2
        ? { matched: false, attachmentId: null, reason: 'ambiguous-visual-reference' }
        : matched(latest)
    }
    if (LATEST_IMAGE_REFERENCE_PATTERN.test(text)) return matched(latest)
    if ((IMMEDIATE_TEMPORAL_PATTERN.test(text) || BARE_IMMEDIATE_DEICTIC_PATTERN.test(text)) && hasImmediateImage(messages)) return matched(latest)

    const strongReference = STRONG_VISUAL_REFERENCE_PATTERN.test(text) || EXPLICIT_VISUAL_SEARCH_PATTERN.test(text)
    const weakImmediateReference = WEAK_DEICTIC_PATTERN.test(text)
      && FOLLOW_UP_PATTERN.test(text)
      && hasImmediateImage(messages)
    if (AMBIGUOUS_DEICTIC_PATTERN.test(text) && candidates.length > 1) return { matched: false, attachmentId: null, reason: 'ambiguous-visual-reference' }
    if (weakImmediateReference) return matched(latest)
    if (!strongReference && !weakImmediateReference) {
      return IMMEDIATE_TEMPORAL_PATTERN.test(text) || BARE_IMMEDIATE_DEICTIC_PATTERN.test(text)
        ? { matched: false, attachmentId: null, reason: 'ambiguous-visual-reference' }
        : matched(null)
    }

    // A visual cue can refer to any of the ten eligible image turns. Use the
    // text/reply around each turn only as a cheap tie-breaker; never call a
    // second model to choose an image.
    const selected = newestByScore(text, candidates)
    return selected
      ? matched(selected)
      : { matched: false, attachmentId: null, reason: 'ambiguous-visual-reference' }
  }

  async resolveFromStore(conversationStore, userText) {
    if (!conversationStore) return matched(null)
    let messages = []
    if (typeof conversationStore.listForRecentVisualRecall === 'function') {
      messages = await conversationStore.listForRecentVisualRecall()
    } else if (typeof conversationStore.list === 'function') {
      messages = await conversationStore.list(500)
    } else if (typeof conversationStore.history === 'function') {
      messages = await conversationStore.history(500)
    }
    return this.resolve(userText, messages)
  }
}

export async function resolveRecentVisualContext({ conversationStore, userText, messages } = {}) {
  const resolver = new RecentVisualResolver()
  if (Array.isArray(messages)) return resolver.resolve(userText, messages)
  return resolver.resolveFromStore(conversationStore, userText)
}
