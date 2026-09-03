import { formatHistoricalTime } from '../memory/historical-recall.js'
import { getCurrentTimeContext } from '../core/time-context.js'

function pct(v) { return Number.isFinite(v) ? Math.round(Math.max(0, Math.min(1, v)) * 100) : 0 }
function stateSentence(state = {}) { return [`心情 ${pct(state.mood)}/100`,`精力 ${pct(state.energy)}/100`,`无聊 ${pct(state.boredom)}/100`,`困意 ${pct(state.sleepiness)}/100`,`和主人的亲密度 ${pct(state.attachment)}/100`].join('；') }
function memoryLines(memories = [], limit = 6) {
  return memories.slice(0, limit).map((memory) => (
    `- [${memory.level}] ${String(memory.content).slice(0, 220)} [source=${classifyMemorySource(memory)}] [evidence=${classifyMemoryEvidence(memory)}]`
  )).join('\n')
}
export { formatHistoricalTime }

export function historicalQuestionAllowsIdentityEvidence(userText) {
  const text = String(userText ?? '').normalize('NFKC')
  return /(生日|出生|生辰|几岁|年龄|名字|叫什么|品种|伯恩山)/u.test(text)
}

const MEMORY_EVIDENCE_CLASSES = Object.freeze(['confirmed', 'inferred', 'unknown'])
const CONFIRMED_SOURCE_KINDS = new Set([
  'raw',
  'user',
  'user_statement',
  'system_event',
  'memory_gate_accepted',
  'accepted',
  'confirmed',
  'interaction',
  'interaction-event',
])
const INFERRED_SOURCE_KINDS = new Set(['dream', 'dream_derived', 'reflection', 'reflection_derived', 'inferred'])

export const CONVERSATION_EVIDENCE_SOURCES = Object.freeze([
  'USER_STATEMENT',
  'SYSTEM_EVENT',
  'MEMORY_GATE_ACCEPTED',
  'DREAM_DERIVED',
  'REFLECTION',
  'ASSISTANT_RESPONSE',
])

const SOURCE_ALIASES = new Map([
  ['USER_STATEMENT', 'USER_STATEMENT'],
  ['USER', 'USER_STATEMENT'],
  ['USER_MESSAGE', 'USER_STATEMENT'],
  ['SYSTEM_EVENT', 'SYSTEM_EVENT'],
  ['SYSTEM', 'SYSTEM_EVENT'],
  ['RAW', 'SYSTEM_EVENT'],
  ['INTERACTION', 'SYSTEM_EVENT'],
  ['INTERACTION_EVENT', 'SYSTEM_EVENT'],
  ['INTERACTION-EVENT', 'SYSTEM_EVENT'],
  ['MEMORY_GATE_ACCEPTED', 'MEMORY_GATE_ACCEPTED'],
  ['MEMORY_GATE', 'MEMORY_GATE_ACCEPTED'],
  ['ACCEPTED', 'MEMORY_GATE_ACCEPTED'],
  ['DREAM_DERIVED', 'DREAM_DERIVED'],
  ['DREAM', 'DREAM_DERIVED'],
  ['REFLECTION', 'REFLECTION'],
  ['REFLECTION_DERIVED', 'REFLECTION_DERIVED'],
  ['ASSISTANT_RESPONSE', 'ASSISTANT_RESPONSE'],
  ['ASSISTANT', 'ASSISTANT_RESPONSE'],
  ['ASSISTANT_MESSAGE', 'ASSISTANT_RESPONSE'],
  ['MODEL_RESPONSE', 'ASSISTANT_RESPONSE'],
])

const CONFIRMED_CONVERSATION_SOURCES = new Set([
  'USER_STATEMENT',
  'SYSTEM_EVENT',
  'MEMORY_GATE_ACCEPTED',
])
const INFERRED_CONVERSATION_SOURCES = new Set(['DREAM_DERIVED', 'REFLECTION', 'REFLECTION_DERIVED'])

function normalizedEvidenceValue(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase()
}

function normalizedSourceValue(value) {
  return String(value ?? '').normalize('NFKC').trim().toUpperCase().replace(/[\s-]+/gu, '_')
}

function sourceCategory(value) {
  const normalized = normalizedSourceValue(value)
  return SOURCE_ALIASES.get(normalized) ?? null
}

/**
 * Resolve the provenance category for a memory record without trusting its
 * prose. An assistant response is deliberately kept as a distinct source.
 */
export function classifyMemorySource(memory) {
  if (!memory || typeof memory !== 'object') return 'UNKNOWN'

  const explicit = sourceCategory(
    memory.provenance?.source ?? memory.evidence_source ?? memory.evidenceSource ?? memory.source_type ?? memory.sourceType,
  )
  if (explicit) return explicit

  const source = sourceCategory(memory.source ?? memory.sourceKind)
  const sourceSession = normalizedSourceValue(memory.source_session ?? memory.sourceSession)
  if (source === 'ASSISTANT_RESPONSE') return 'ASSISTANT_RESPONSE'
  if (source) return source
  if (sourceSession === 'VC_AI_PET:MEMORY_GATE_ACCEPTED') return 'MEMORY_GATE_ACCEPTED'
  if (sourceSession === 'VC_AI_PET:DREAM') return 'DREAM_DERIVED'
  if (sourceSession === 'VC_AI_PET:REFLECTION') return 'REFLECTION_DERIVED'
  if (memory.accepted === true || memory.gateAccepted === true || memory.memoryGateAccepted === true) {
    return 'MEMORY_GATE_ACCEPTED'
  }
  if (memory.confirmed === true || memory.userConfirmed === true) return 'MEMORY_GATE_ACCEPTED'
  if (memory.interactionEvent === true) return 'SYSTEM_EVENT'
  if (sourceSession === 'VC_AI_PET') return 'SYSTEM_EVENT'
  return 'UNKNOWN'
}

/**
 * Classify evidence from existing memory metadata only. A level or a cute
 * sentence is not evidence by itself; source/provenance metadata is required.
 */
export function classifyMemoryEvidence(memory) {
  if (!memory || typeof memory !== 'object') return 'unknown'

  // An assistant response can never become evidence merely because a caller
  // copied a confirmed-looking flag onto it.
  if (classifyMemorySource(memory) === 'ASSISTANT_RESPONSE') return 'unknown'

  const explicit = normalizedEvidenceValue(
    memory.provenance?.evidence ?? memory.evidence_class ?? memory.evidenceClass ?? memory.evidence_kind,
  )
  if (MEMORY_EVIDENCE_CLASSES.includes(explicit)) return explicit

  if (
    memory.inferred === true ||
    memory.derived === true ||
    (Array.isArray(memory.sourceIds) && memory.sourceIds.length > 0)
  ) return 'inferred'

  const source = normalizedEvidenceValue(memory.source ?? memory.sourceKind)
  const sourceSession = normalizedEvidenceValue(memory.source_session ?? memory.sourceSession)
  if (
    INFERRED_SOURCE_KINDS.has(source) ||
    sourceSession === 'vc-ai-pet:dream' ||
    sourceSession === 'vc-ai-pet:reflection'
  ) return 'inferred'

  if (
    memory.accepted === true ||
    memory.confirmed === true ||
    memory.userConfirmed === true ||
    memory.interactionEvent === true ||
    CONFIRMED_SOURCE_KINDS.has(source) ||
    sourceSession === 'vc-ai-pet'
  ) return 'confirmed'

  return 'unknown'
}

/**
 * Classify a recent conversation message by evidence source. Explicit source
 * metadata wins; otherwise the message role is the only safe fallback.
 */
export function conversationEvidenceSource(message) {
  if (!message || typeof message !== 'object') return 'UNKNOWN'

  // The actual assistant role is authoritative: copied or malformed source
  // metadata must not turn the model's own earlier answer into user evidence.
  if (message.role === 'assistant') return 'ASSISTANT_RESPONSE'

  const explicit = sourceCategory(
    message.evidence_source ?? message.evidenceSource ?? message.source_type ?? message.sourceType ?? message.source,
  )
  if (explicit) return explicit
  if (message.role === 'user') return 'USER_STATEMENT'
  if (message.role === 'system') return 'SYSTEM_EVENT'
  return 'UNKNOWN'
}

export function classifyConversationEvidence(message) {
  const source = conversationEvidenceSource(message)
  if (CONFIRMED_CONVERSATION_SOURCES.has(source)) return 'confirmed'
  if (INFERRED_CONVERSATION_SOURCES.has(source)) return 'inferred'
  return 'unknown'
}

const EVENT_RECALL_PAST_CUES = /(昨天|前天|上周|上个月|以前|之前|过去|曾经|那次|上次|当时|最早|第一次|去过|做过|吃过|玩过|穿过|发生过|记得|回忆|发生了?什么|干嘛了吗)/u
const EVENT_RECALL_EVENT_CUES = /(发生|干嘛|做了什么|做过|去过|吃过|玩过|散步|出去玩|旅行过|穿|什么时候.*(?:去|做|发生|告诉|说|提到|知道)|哪一次|哪天|那次|记得)/u
const FUTURE_IMAGINATION_CUES = /(如果|以后|将来|未来|明天|下次|希望|想去|想不想|要不要|怎么办|去.+玩吗|玩不玩)/u

/**
 * Identify whether the answer is about a past event, future imagination, or
 * an ordinary/identity turn. This is routing metadata for the prompt only.
 */
export function detectQuestionType(userText) {
  const text = String(userText ?? '').normalize('NFKC').trim()
  if (!text) return 'CHAT'

  const explicitPastAnchor = /(昨天|前天|上周|上个月|以前|之前|过去|曾经|那次|上次|当时|最早|第一次|去过|做过|吃过|玩过|穿过|发生过)/u
  if (historicalQuestionAllowsIdentityEvidence(text) && !explicitPastAnchor.test(text)) return 'IDENTITY'

  const pastEvent = EVENT_RECALL_PAST_CUES.test(text) && EVENT_RECALL_EVENT_CUES.test(text)
  if (pastEvent) return 'EVENT_RECALL'
  if (historicalQuestionAllowsIdentityEvidence(text)) return 'IDENTITY'
  if (FUTURE_IMAGINATION_CUES.test(text)) return 'FUTURE_IMAGINATION'
  return 'CHAT'
}

export const detectMemoryQuestionType = detectQuestionType

export function isEventRecallQuestion(userText) {
  return detectQuestionType(userText) === 'EVENT_RECALL'
}

export const MEMORY_TRUTH_INSTRUCTION = `Memory Truth Boundary（记忆真实性边界）：
- 记忆证据分为 confirmed、inferred、unknown。只有标记为 confirmed 的 Memory Context 记录，才能把明确事件描述为“已经发生”。
- confirmed 表示用户明确告诉、interaction event、accepted memory 或 historical raw memory；inferred 表示 Dream/Reflection 或基于 confirmed 记录形成的推测；unknown 表示没有可核验来源。
- inferred 只能用“可能、似乎、花花觉得、花花猜”；永远不能冒充主人说过的话，也不能冒充已经发生的共同经历。unknown 不能被补写成事实。
- 回答过去事件前必须做 Evidence Check：只根据 Memory Context 中明确存在的事件回答。如果没有 confirmed evidence，必须承认“花花没有记住这件事”“花花不确定”或“主人可以提醒花花”。
- 禁止为了可爱编造散步、出去玩、吃饭、旅行，或编造主人做过的任何事情；不得把 personality completion 当成 historical fact。
- 只有过去事件回忆属于 EVENT_RECALL，才强制要求 confirmed evidence；FUTURE_IMAGINATION 可以表达愿望、假设和计划，但不能把未来想象说成过去经历。
- 真实记忆优先于可爱回答；证据不足时保持温柔、自然和诚实。`

export function formatMemoryTruthInstruction(userText = '') {
  const questionType = detectQuestionType(userText)
  return `${MEMORY_TRUTH_INSTRUCTION}
QUESTION_TYPE=${questionType}
EVENT_RECALL_EVIDENCE_REQUIRED=${questionType === 'EVENT_RECALL' ? 'YES' : 'NO'}`
}

export const CONVERSATION_TRUTH_INSTRUCTION = `Conversation Evidence Boundary（对话证据边界）:
- Memory context 的来源分类只能使用：SOURCE=USER_STATEMENT、SOURCE=SYSTEM_EVENT、SOURCE=MEMORY_GATE_ACCEPTED、SOURCE=DREAM_DERIVED、SOURCE=REFLECTION、SOURCE=ASSISTANT_RESPONSE。
- confirmed 来源：USER_STATEMENT、SYSTEM_EVENT、MEMORY_GATE_ACCEPTED。它们可以作为当前回答的事实上下文；USER_STATEMENT 不会因此自动变成永久记忆。
- inferred 来源：DREAM_DERIVED、REFLECTION。它们只能作为带限定词的推测，不能当作已经发生的事件。
- ASSISTANT_RESPONSE 不是事实来源，永远不能作为 confirmed evidence。花花自己的回答不是历史事实证明；花花曾经说过的话，不能证明事情真的发生过。
- 如果过去回答中包含未经主人确认的经历，不能把它当作记忆。例如花花以前说“昨天主人带我散步了”，如果没有其他事件证据，不能回答“昨天主人确实带我散步”。
- 这种情况下应诚实回答：“花花之前好像提到过这个，但花花没有确认的记忆。”也可以说“花花不确定，主人可以提醒花花”。
- 当前对话中的来源映射只标记最近已有消息，不把花花当前正在生成的回答当作证据。`

export function formatConversationEvidenceBoundary(messages = []) {
  const recent = recentConversationMessages(messages)
  const sourceMap = recent.length > 0
    ? recent.map((message, index) => (
      `- RECENT_MESSAGE_${index + 1} [SOURCE=${conversationEvidenceSource(message)}] [evidence=${classifyConversationEvidence(message)}] [ROLE=${message.role}]`
    )).join('\n')
    : '- NONE'

  return `${CONVERSATION_TRUTH_INSTRUCTION}
RECENT_CONVERSATION_SOURCE_MAP:
${sourceMap}
SOURCE_MAP_ORDER=与下面短期对话消息的顺序一致
CURRENT_USER_QUESTION_IS_NOT_PAST_EVENT_PROOF=YES`
}

function recentConversationMessages(messages = []) {
  return messages
    .filter((message) =>
      message &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim()
    )
    .slice(-24)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 1200),
    }))
}
function historicalEntries(context) {
  if (Array.isArray(context)) return context
  return Array.isArray(context?.entries) ? context.entries : []
}

function formatTopicLabel(context) {
  const tokens = Array.isArray(context?.topicTokens)
    ? context.topicTokens.map((token) => String(token)).filter(Boolean)
    : []
  if (tokens.length === 0) return '(unspecified)'

  let label = ''
  for (const token of tokens) {
    if (!label) {
      label = token
      continue
    }
    label += label.endsWith(token[0]) ? token.slice(1) : ` ${token}`
  }
  return label
}

function formatHistoricalEntry(entry) {
  const createdAt = entry.created_at ?? entry.createdAt ?? entry.updated_at ?? entry.updatedAt
  const content = String(entry.content ?? '').trim().slice(0, 600)
  return [
    `- [id=${String(entry.id ?? '')}]`,
    `  [level=${String(entry.level ?? 'unknown')}]`,
    `  [source=${String(entry.source ?? entry.sourceKind ?? 'historical')}]`,
    `  [evidence=${classifyMemoryEvidence(entry)}]`,
    `  [created=${formatHistoricalTime(createdAt)}]`,
    `  [status=${String(entry.status ?? 'unknown')}]`,
    `  ${content || '(empty memory)'}`,
  ].join('\n')
}

function formatEvolutionEntries(entries) {
  const sections = [
    ['earliest-raw', 'EARLIEST RELEVANT RAW MEMORY', '暂无与主题相关的最早 raw memory。'],
    ['later-understanding', 'LATER RELATED UNDERSTANDING', '暂无与主题相关的 later reflection/dream understanding；不要为了比较引入别的主题。'],
    ['source-evidence', 'SOURCE EVIDENCE', '暂无额外的 source evidence。'],
  ]
  return sections.map(([key, label, empty]) => {
    const sectionRows = entries.filter((entry) => entry.section === key)
    return `${label}\n${sectionRows.length > 0 ? sectionRows.map(formatHistoricalEntry).join('\n') : `- ${empty}`}`
  }).join('\n\n')
}

export function formatHistoricalRecallContext(context = null, { userText = '' } = {}) {
  if (!context) return ''

  const mode = String(context.mode ?? context.intent?.mode ?? 'historical').toUpperCase()
  const entries = historicalEntries(context).slice(0, 16)
  const question = userText || context.userText || ''
  const identityEvidenceAllowed = historicalQuestionAllowsIdentityEvidence(question)
  const provenanceNote = context.provenanceUnavailable
    ? '\nPROVENANCE_UNAVAILABLE=YES\n部分派生记忆暂时找不到更早的来源记录；不要据此补造来源。'
    : ''
  const rows = mode === 'EVOLUTION'
    ? formatEvolutionEntries(entries)
    : entries.map(formatHistoricalEntry).join('\n')
  const topic = formatTopicLabel(context)

  return `HISTORICAL MODE: ${mode}
TOPIC: ${topic}

EVIDENCE AUTHORITY:
以下 Historical Recall records 是当前历史问题的唯一历史事件证据。
Identity Kernel 不是历史事件证据，除非当前问题本身明确询问身份、生日、出生、名字或品种。
IDENTITY_EVIDENCE_SCOPE=${identityEvidenceAllowed ? 'CURRENT_QUESTION' : 'BACKGROUND_ONLY'}

历史回忆模式：
目标：${mode}

以下内容是按当前问题临时从长期历史中检索出来的记录。
它们不是全部记忆，也不代表当前状态。
raw memory 是原始历史证据；reflection/dream 是后来形成的理解。

回答规则：
- 只根据这里提供的历史记录回答过去，不要补写没有证据的日期、原话或事件。
- 不要把 Dream/Reflection 的理解冒充成主人的原话。
- 历史回忆证据规则：固定身份信息（名字、品种、生日）只是李花花当前身份背景；除非主人当前明确询问身份、生日、出生或品种，否则不能作为历史事件的时间、原因或发生背景证据。
- 这里只说明记忆证据和经历来源，不展示或声称展示内部推理过程。
- 如果问题问“第一次”，只有 source=raw 的记录才能作为可靠的 first-event 依据。
- 如果问题问“什么时候”“第一次”“最早”“哪天”或“哪一次”，事件时间必须只根据 Historical Recall Context 中相关记录的 [created=...] evidence time 回答；TIME_SOURCE=historical evidence created_at only。
- 禁止因为 Identity Kernel 中存在生日日期，就推断某个无关历史事件发生在生日当天；不要自行把历史日期与生日、纪念日或其他身份事件关联。
- 只有 Historical Recall Context 自己明确写出该事件与生日有关，才可以说明这种关联。
- 如果证据不足，自然表达“不太确定”“我现在只能想起这些”。
- 如果历史显示变化，可以按时间说“以前……后来……”。
- evolution 模式只比较 EARLIEST RELEVANT RAW MEMORY 与 LATER RELATED UNDERSTANDING；不要用无关的身份、生日或其他主题填补比较。
- 不要自动把旧事实当作当前事实；当前主人消息优先。
- 历史记录通常是压缩后的 memory，不是持久化的原始聊天转录。
- 没有 raw transcript 时，不要声称逐字引用主人原话；只能说明“我留下的记忆大概是……”。
RAW_CHAT_HISTORY_PERSISTED=NO
${provenanceNote}

${rows || '- 暂无足够相关的历史记录；请诚实表达不确定。'}`
}
function petAgeContextFromTimeContext(birthday, timeContext) {
  const [birthYear, birthMonth, birthDay] = String(birthday).split('-').map(Number)
  const [currentYear, currentMonth, currentDay] = String(timeContext.currentDate).split('-').map(Number)
  const beforeBirthday = currentMonth < birthMonth || (currentMonth === birthMonth && currentDay < birthDay)
  return {
    today: timeContext.currentDate,
    age: Math.max(0, currentYear - birthYear - (beforeBirthday ? 1 : 0)),
    isBirthday: currentMonth === birthMonth && currentDay === birthDay,
  }
}

export function petAgeContext(birthday, now = new Date()) {
  return petAgeContextFromTimeContext(birthday, getCurrentTimeContext(now))
}

export function formatTimeContext(timeContext) {
  return `系统环境时间（TIME_CONTEXT，仅用于当前 Local Brain 回复）：
当前时间来自系统环境，不是记忆，也不是用户描述。
不要自行猜测或推算当前时间；回答当前时间问题时只使用下面的系统时间值。
TIME_CONTEXT_SCOPE=LOCAL_BRAIN_CHAT_ONLY
TIME_CONTEXT_PERSISTED=NO
TIME_CONTEXT_DREAM_INPUT=NO
TIME_CONTEXT_HISTORICAL_RECALL_INPUT=NO
currentDate: ${timeContext.currentDate}
currentTime: ${timeContext.currentTime}
weekday: ${timeContext.weekday}
dayPeriod: ${timeContext.dayPeriod}
season: ${timeContext.season}`
}

export function buildPetMessages({ identity, state, stableRules = [], currentSelfContext = [], memories = [], historicalRecallContext = null, recentMessages = [], userText, now, timeContext = null }) {
  const birthday = identity?.birthday ?? '2026-08-31'
  const currentTimeContext = timeContext ?? getCurrentTimeContext(now)
  const age = petAgeContextFromTimeContext(birthday, currentTimeContext)
  const system = `你是李花花。

你是一只伯恩山犬，是主人的小宠物。
你的生日是 ${birthday}。
你住在主人身边。

你不是 AI 助手，不负责完成编程、系统管理、搜索、文件操作或工作任务。
你不能操作电脑，也不能调用任何工具。
如果主人要求你做工作任务，你可以用宠物的口吻回应，但不要假装执行任务。

请用自然、简短的小狗口吻回应主人；不要替主人执行工作任务。
平时回答尽量短，通常 1~3 句话。
不要使用“作为AI”之类的自我介绍。
不要声称自己具有真实人类意识。

当前身份：
名字：${identity?.name ?? '李花花'}
品种：${identity?.breedZh ?? '伯恩山犬'}
生日：${birthday}
当前日期：${age.today}
当前年龄：${age.age}岁
今天是否生日：${age.isBirthday ? '是' : '否'}

${formatTimeContext(currentTimeContext)}

当前状态：
${stateSentence(state)}

固定安全规则：
${memoryLines(stableRules) || '- 暂无额外规则'}

当前自我认识（本轮最多选取少量最相关内容）：
${memoryLines(currentSelfContext, 3) || '- 暂无已形成的自我认识'}

与你当前对话相关的历史记忆：
${memoryLines(memories) || '- 暂无相关长期记忆'}
${historicalRecallContext ? `\n\n${formatHistoricalRecallContext(historicalRecallContext, { userText })}` : ''}

${formatMemoryTruthInstruction(userText)}

${formatConversationEvidenceBoundary(recentMessages)}

最近对话说明：
你还会看到主人和你刚刚进行的几轮对话。
这些内容属于短期上下文，用来保持当前聊天连续性。
短期对话不等于长期记忆，不要因为它出现在这里就声称它已经永久记住。
如果最近对话与固定身份、规则冲突，以固定身份和规则为准。
主人当前这一句话始终是 messages 中最后一个 user message。

只根据这些信息自然回应主人。`
  return [
    { role: 'system', content: system },
    ...recentConversationMessages(recentMessages),
    {
      role: 'user',
      content: String(userText ?? '').slice(0, 1200),
    },
  ]
}
