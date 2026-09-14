import { buildPetMessages, CONVERSATION_TRUTH_INSTRUCTION, conversationEvidenceSource, classifyConversationEvidence } from '../src/brain/prompt-builder.js'
import { MEMORY_OUTPUT_INSTRUCTION } from '../src/brain/memory-candidate.js'
import { BELIEF_OUTPUT_INSTRUCTION, formatBeliefContext } from '../src/memory/current-belief.js'

const turns = Array.from({ length: 50 }, (_, index) => ({
  user: `主人第${index + 1}轮说：今天下班回家以后，我想和花花一起在客厅玩一会儿，也会告诉花花今天发生的小事情。`,
  assistant: `花花第${index + 1}轮回答：好呀，花花会在门口等主人，听主人慢慢说，也会记得这只是我们最近的聊天。`,
}))
const recentMessages = turns.flatMap(({ user, assistant }) => [
  { role: 'user', content: user },
  { role: 'assistant', content: assistant },
])
const built = buildPetMessages({
  identity: { name: '李花花', breedZh: '伯恩山犬', birthday: '2026-08-31' },
  state: { mood: 0.8, energy: 0.7, boredom: 0.2, sleepiness: 0.1, attachment: 0.9 },
  memories: [{ level: 'fact', content: '主人喜欢和花花一起散步。', provenance: { source: 'USER_STATEMENT', evidence: 'confirmed' } }],
  recentMessages,
  userText: '花花，今天还要一起玩吗？',
  contextTurns: 50,
  now: new Date('2026-09-14T20:00:00+08:00'),
})

const baseAfter = built[0].content
const boundaryStart = baseAfter.indexOf('RECENT_CONVERSATION_EVIDENCE:')
const boundaryEnd = baseAfter.indexOf('\n\n最近对话说明：', boundaryStart)
if (boundaryStart < 0 || boundaryEnd < 0) throw new Error('compact evidence declaration not found')

const legacySourceMap = recentMessages.map((message, index) => (
  `- RECENT_MESSAGE_${index + 1} [SOURCE=${conversationEvidenceSource(message)}] [evidence=${classifyConversationEvidence(message)}] [ROLE=${message.role}]`
)).join('\n')
const beforeBoundary = `RECENT_CONVERSATION_SOURCE_MAP:\n${legacySourceMap}\nSOURCE_MAP_ORDER=与下面短期对话消息的顺序一致\nCURRENT_USER_QUESTION_IS_NOT_PAST_EVENT_PROOF=YES`
const baseBefore = `${baseAfter.slice(0, boundaryStart)}${beforeBoundary}${baseAfter.slice(boundaryEnd)}`
// LocalBrain.reply appends these exact structured-output instructions before
// its client call; include them so the measurement covers the actual system
// payload, not only the prompt builder's base text.
const systemSuffix = `\n\n${MEMORY_OUTPUT_INSTRUCTION}\n\n${BELIEF_OUTPUT_INSTRUCTION}\n${formatBeliefContext([])}`
const before = `${baseBefore}${systemSuffix}`
const after = `${baseAfter}${systemSuffix}`

async function probe(path) {
  try {
    const response = await fetch(`http://127.0.0.1:17862${path}`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function localTokenCount(content) {
  try {
    const response = await fetch('http://127.0.0.1:17862/tokenize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(5_000),
    })
    const payload = await response.json()
    if (response.ok && Array.isArray(payload?.tokens)) return payload.tokens.length
  } catch {}
  return null
}

const [models, props, beforeTokens, afterTokens] = await Promise.all([
  probe('/v1/models'),
    probe('/props'),
  localTokenCount(before),
  localTokenCount(after),
])
const fallback = (value) => Math.ceil(String(value).length * 0.75)
const tokenizer = beforeTokens !== null && afterTokens !== null ? 'LOCAL_BRAIN_QWEN_TOKENIZE' : 'FALLBACK_CJK_CHAR_ESTIMATE(length*0.75)'
const beforeEstimate = beforeTokens ?? fallback(before)
const afterEstimate = afterTokens ?? fallback(after)
const nCtx = models?.data?.[0]?.meta?.n_ctx ?? models?.models?.[0]?.details?.n_ctx ?? 'UNAVAILABLE'

console.log(`TOKENIZER=${tokenizer}`)
console.log(`LOCAL_BRAIN_MODELS_N_CTX=${nCtx}`)
console.log(`LOCAL_BRAIN_PROPS_N_CTX=${props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? 'UNAVAILABLE'}`)
console.log('FIXTURE_TURNS=50')
console.log(`SYSTEM_TOKEN_ESTIMATE_BEFORE=${beforeEstimate}`)
console.log(`SYSTEM_TOKEN_ESTIMATE_AFTER=${afterEstimate}`)
console.log(`SYSTEM_PROMPT_TOKEN_REDUCTION=${beforeEstimate - afterEstimate}`)
console.log(`SYSTEM_PROMPT_TOKEN_REDUCTION_PCT=${((beforeEstimate - afterEstimate) / beforeEstimate * 100).toFixed(2)}`)
console.log(`SYSTEM_PROMPT_AFTER_LT_6000=${afterEstimate < 6000 ? 'YES' : 'NO'}`)
