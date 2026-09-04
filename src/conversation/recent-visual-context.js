export const RECENT_VISUAL_MAX_ATTACHMENTS = 10
export const RECENT_VISUAL_WINDOW = '10_IMAGE_MESSAGES'

const LATEST_IMAGE_REFERENCE_PATTERN = /(上一张|刚才那张|前面那张|最后一张|最新那张|最近那张)/u
const STRONG_VISUAL_REFERENCE_PATTERN = /(图片|照片|图像|截图|图里|图中|这张图|这张图片|上一张|刚才那张|前面那张|再看一下|再看看|看看|重新看看|仔细看看|仔细看|看清楚|你再看|图片里面|照片里面|画面里)/u
const WEAK_DEICTIC_PATTERN = /(这|这个|这些|它|那个|刚才那个|里面那个)/u
const FOLLOW_UP_PATTERN = /(吗|么|呢|？|\?|是不是|是否|真的吗|真的|什么|哪|怎么|多少|好不好|能不能|可以吗|看起来|看清|仔细|吃|喝|味道|叶子|颜色|画面|内容|是什么|怎么样|如何|像不像|对不对|有没有|好看|漂亮|可爱|不错|真实|真假|应该|感觉)/u

// These characters occur in almost every short Chinese turn. Removing them
// from the lightweight overlap score keeps a shared "这/是/看" from beating
// a candidate that actually mentions the subject being asked about.
const CJK_STOP_CHARACTERS = new Set('这个些它那个刚才里面张的是吗呢啊呀我你主人花花再看一下重新仔细清楚图片照片图像截图画面什么真的'.split(''))

function cleanText(value) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, 1200)
}

function attachmentIdFromMessage(message) {
  const id = message?.attachment?.id ?? message?.attachmentId
  const clean = String(id ?? '').trim()
  return /^[a-z0-9_-]{1,80}$/iu.test(clean) ? clean : null
}

function timestampOf(message) {
  const timestamp = Number(message?.timestamp)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0
}

function relatedAssistantText(messages, userIndex) {
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === 'user') break
    if (message?.role === 'assistant') return cleanText(message.text ?? message.content)
  }
  return ''
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
    const attachmentId = attachmentIdFromMessage(message)
    if (!attachmentId) return
    candidates.push({
      attachmentId,
      userText: cleanText(message.text ?? message.content),
      assistantText: relatedAssistantText(source, index),
      timestamp: timestampOf(message),
      messageIndex: index,
    })
  })
  return candidates.slice(-limit)
}

function hasImmediateImage(messages) {
  const users = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'user')
  return users.slice(-2).some((message) => Boolean(attachmentIdFromMessage(message)))
}

function cjkTerms(text) {
  const terms = new Map()
  const runs = cleanText(text).match(/[\u3400-\u9fff]+/gu) ?? []
  for (const run of runs) {
    for (const character of run) {
      if (!CJK_STOP_CHARACTERS.has(character)) terms.set(character, 1)
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      const term = run.slice(index, index + 2)
      if ([...term].some((character) => CJK_STOP_CHARACTERS.has(character))) continue
      terms.set(term, 3)
    }
  }
  return terms
}

function keywordTerms(text) {
  const terms = cjkTerms(text)
  const ascii = cleanText(text).toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]*/giu) ?? []
  for (const term of ascii) terms.set(term, 3)
  return terms
}

function overlapScore(query, candidate) {
  const queryTerms = keywordTerms(query)
  const candidateTerms = keywordTerms(`${candidate.userText} ${candidate.assistantText}`)
  let score = 0
  for (const [term, weight] of queryTerms) {
    if (candidateTerms.has(term)) score += Math.min(weight, candidateTerms.get(term))
  }
  return score
}

function newestByScore(query, candidates) {
  let best = candidates.at(-1)
  let bestScore = -1
  for (const candidate of candidates) {
    const score = overlapScore(query, candidate)
    if (score > bestScore || (score === bestScore && candidate.messageIndex > best.messageIndex)) {
      best = candidate
      bestScore = score
    }
  }
  return best
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
    const candidates = collectRecentVisualCandidates(messages, this.maxAttachments)
    if (!text || candidates.length === 0) return matched(null)

    const latest = candidates.at(-1)
    if (LATEST_IMAGE_REFERENCE_PATTERN.test(text)) return matched(latest)

    const strongReference = STRONG_VISUAL_REFERENCE_PATTERN.test(text)
    const weakImmediateReference = WEAK_DEICTIC_PATTERN.test(text)
      && FOLLOW_UP_PATTERN.test(text)
      && hasImmediateImage(messages)
    if (!strongReference && !weakImmediateReference) return matched(null)

    // A visual cue can refer to any of the ten eligible image turns. Use the
    // text/reply around each turn only as a cheap tie-breaker; never call a
    // second model to choose an image.
    return matched(newestByScore(text, candidates))
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
