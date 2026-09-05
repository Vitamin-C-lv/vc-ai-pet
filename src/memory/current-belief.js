import { randomUUID } from 'node:crypto'
import { tokenize } from 'meow-memory'

const DAY = 86400000
const CHANGES = new Set(['assert', 'change', 'correction', 'temporary', 'uncertain', 'retract'])
const CHANGE_CUE = /现在|目前|最近|开始|变成|改为|改成|越来越|不再|如今|以后|now|recently|no longer/iu
const CORRECTION_CUE = /纠正|更正|说错|记错|不对|不是.*而是|其实|correction|was wrong/iu
const UNKNOWN_CUE = /不知道|不确定|没想好|说不准|不清楚|没有.*最喜欢|取消|不再确定|可能|也许|大概|好像|似乎|unknown|not sure|maybe|probably/iu
const TEMPORARY_CUE = /今天|今晚|这周|这星期|这几天|暂时|这次|today|temporarily/iu
const NON_ASSERTION = /[?？]|如果|假如|比如|例如|他说|她说|你说|你觉得|你认为|是不是|是否|要是|假设|if |suppose/iu
const STOP = new Set(['我', '主人', '你', '花花', '现在', '以前', '什么', '记得', '告诉', '自己', '觉得', '认为', '怎么', '为什么', '最近', '目前'])

export const containsNonAssertion = text => NON_ASSERTION.test(String(text ?? ''))

function terms(text) {
  return [...new Set(tokenize(String(text ?? '')).filter((t) => t.length >= 2 && !STOP.has(t)))].slice(0, 48)
}

export const BELIEF_OUTPUT_SCHEMA = {
  type: 'array', maxItems: 2,
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      topic: { type: 'string', minLength: 1, maxLength: 40 },
      value: { type: 'string', maxLength: 100 },
      quote: { type: 'string', minLength: 2, maxLength: 200 },
      change: { type: 'string', enum: [...CHANGES] },
    },
    required: ['topic', 'value', 'quote', 'change'],
  },
}

export const BELIEF_OUTPUT_INSTRUCTION = `CURRENT BELIEF EXTRACTION:
beliefs 是本次主人明确陈述的、以后有用的原子状态（最多2条；问句/猜测/举例/引用别人/寒暄返回[]）。
topic 是稳定的单一属性名称，例如“最喜欢的颜色”“喝咖啡频率”，同一属性必须复用下面已有 topic。不同属性不要混合。
value 必须逐字摘自主人的原文，保留否定、限定词和频率；不能用你自己的总结。quote 必须是包含该 value 的完整原文陈述，保留限定条件。
change: assert=普通明确陈述；change=明确现在/最近发生改变；correction=纠正以前信息；temporary=今天/这周的临时状态；uncertain=不确定；retract=取消旧判断。
uncertain/retract 的 value 为空。不能从图片、你的回复、旧记忆或梦提取主人事实。不能猜主人性格。
这是信息抽取，不是改写原始聊天；不确定是否适用时返回[]。`

// Evidence and interpretation are separate. The immutable assertion stores a
// literal quote and its source message; only the small projection is replaced.
export class CurrentBeliefStore {
  constructor(database) {
    this.db = database
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pet_belief_assertions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        topic TEXT NOT NULL, value TEXT NOT NULL, quote TEXT NOT NULL,
        change_kind TEXT NOT NULL, message_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
        expires_at INTEGER, UNIQUE(message_id, topic)
      );
      CREATE INDEX IF NOT EXISTS pet_belief_topic_history ON pet_belief_assertions(topic, seq);
      CREATE TABLE IF NOT EXISTS pet_current_beliefs (
        topic TEXT PRIMARY KEY, state TEXT NOT NULL, assertion_ids TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pet_belief_terms (
        term TEXT NOT NULL, topic TEXT NOT NULL, PRIMARY KEY(term, topic)
      );
    `)
  }

  consider(proposals, message) {
    if (message?.role !== 'user' || !message.id || message.attachment || message.kind && message.kind !== 'dialogue') return []
    const text = String(message.text ?? '')
    if (/(?:不要|别|不用|不许).{0,8}(?:记|保存|存下来)|密码|password|token|api\s*key|密钥|secret|验证码/iu.test(text) || NON_ASSERTION.test(text)) return []
    const at = Number(message.timestamp)
    if (!Number.isFinite(at)) return []
    const results = []
    for (const raw of (Array.isArray(proposals) ? proposals : []).slice(0, 2)) {
      if (!raw || typeof raw !== 'object') continue
      const { topic, value, quote, change } = raw
      if (typeof topic !== 'string' || !topic.trim() || topic.length > 40 || typeof value !== 'string' || value.length > 100 || typeof quote !== 'string' || quote.length < 2 || quote.length > 200 || !text.includes(quote) || !CHANGES.has(change)) continue
      if (!/(?:我|我的|I\b|my\b)/iu.test(quote) || NON_ASSERTION.test(quote)) continue
      if (['uncertain', 'retract'].includes(change) ? value !== '' || !UNKNOWN_CUE.test(text) : !value || !quote.includes(value)) continue
      // The literal quote is authoritative, including negation and scope. A
      // model cannot turn “I do not drink coffee” into a confirmed “coffee”.
      let kind = change
      if (UNKNOWN_CUE.test(quote)) kind = 'uncertain'
      else if (TEMPORARY_CUE.test(quote)) kind = 'temporary'
      else if (kind === 'change' && !CHANGE_CUE.test(quote)) kind = 'assert'
      else if (kind === 'correction' && !CORRECTION_CUE.test(text)) kind = 'assert'
      if (kind === 'temporary' && !TEMPORARY_CUE.test(quote)) continue
      const expires = kind === 'temporary' ? at + (/这周|这星期|这几天/u.test(quote) ? 7 : 1) * DAY : null
      const id = randomUUID()
      this.db.exec('SAVEPOINT current_belief')
      try {
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO pet_belief_assertions
          (id, topic, value, quote, change_kind, message_id, observed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, topic.trim(), kind === 'uncertain' ? '' : value, quote, kind, message.id, at, expires)
        if (Number(inserted.changes) === 0) { this.db.exec('RELEASE current_belief'); continue }
        const latest = this.db.prepare('SELECT updated_at FROM pet_current_beliefs WHERE topic = ?').get(topic.trim())
        if (latest && latest.updated_at > at) {
          // Concurrent turns can finish out of order. Rebuild this one topic
          // in source time, without overwriting either original statement.
          this.db.prepare('DELETE FROM pet_current_beliefs WHERE topic = ?').run(topic.trim())
          for (const row of this.db.prepare('SELECT * FROM pet_belief_assertions WHERE topic = ? ORDER BY observed_at, seq').all(topic.trim())) {
            this.#project(row.topic, row.id, row.change_kind, row.value, row.quote, row.observed_at)
          }
        } else this.#project(topic.trim(), id, kind, value, quote, at)
        const insertTerm = this.db.prepare('INSERT OR IGNORE INTO pet_belief_terms(term, topic) VALUES (?, ?)')
        for (const term of terms(`${topic} ${quote}`)) insertTerm.run(term, topic.trim())
        this.db.exec('RELEASE current_belief')
        results.push({ topic: topic.trim(), id, status: 'recorded' })
      } catch (error) {
        this.db.exec('ROLLBACK TO current_belief; RELEASE current_belief')
        throw error
      }
    }
    return results
  }

  #project(topic, id, kind, value, quote, at) {
    const previous = this.current(topic, at)
    let ids = [id]
    let state = ['uncertain', 'retract'].includes(kind) ? 'unknown' : kind === 'temporary' ? 'temporary' : 'supported'
    if (kind === 'assert' && previous && ['supported', 'contested'].includes(previous.state)) {
      // Different ordinary assertions are a contradiction, not automatically
      // a change. Only an explicit change/correction closes that uncertainty.
      const negative = (text) => /不|没|从未|never|not\b/iu.test(text)
      if (previous.alternatives.some((a) => a.value !== value || negative(a.quote) !== negative(quote))) {
        ids = [...new Set([...previous.alternatives.map((a) => a.id), id])].slice(-4)
        state = 'contested'
      }
    }
    this.db.prepare(`INSERT INTO pet_current_beliefs(topic, state, assertion_ids, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(topic) DO UPDATE SET state=excluded.state, assertion_ids=excluded.assertion_ids, updated_at=excluded.updated_at`)
      .run(topic, state, JSON.stringify(ids), at)
  }

  current(topic, now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM pet_current_beliefs WHERE topic = ?').get(topic)
    if (!row) return null
    const alternatives = JSON.parse(row.assertion_ids).map((id) => this.db.prepare('SELECT * FROM pet_belief_assertions WHERE id = ?').get(id)).filter(Boolean)
    const expired = alternatives.some((a) => a.expires_at !== null && a.expires_at <= now)
    // A temporary state expiring never silently resurrects an older claim.
    const state = expired ? 'unknown' : row.state
    return {
      topic, state, confidence: state === 'supported' ? 0.9 : state === 'temporary' ? 0.7 : state === 'contested' ? 0.4 : 0,
      evidence: 'USER_STATEMENT', interpretation: 'extracted', updatedAt: row.updated_at,
      reason: expired ? 'temporary-expired' : state,
      alternatives: alternatives.map(({ id, value, quote, change_kind, message_id, observed_at, expires_at }) => ({ id, value, quote, change: change_kind, messageId: message_id, observedAt: observed_at, expiresAt: expires_at })),
    }
  }

  topicsFor(query, limit = 4) {
    const tokens = terms(query)
    if (!tokens.length) return []
    return this.db.prepare(`SELECT topic, COUNT(*) AS score FROM pet_belief_terms WHERE term IN (${tokens.map(() => '?').join(',')})
      GROUP BY topic ORDER BY score DESC, topic LIMIT ?`).all(...tokens, Math.max(1, Math.min(4, limit))).map((row) => row.topic)
  }

  history(topic, { before = Number.MAX_SAFE_INTEGER, limit = 12 } = {}) {
    const count = Math.max(1, Math.min(50, Number(limit) || 12))
    const rows = this.db.prepare('SELECT * FROM pet_belief_assertions WHERE topic = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(topic, before, count)
    return { entries: rows.reverse(), nextBefore: rows.length === count ? rows[0].seq : null }
  }

  context(query, { now = Date.now(), historical = false } = {}) {
    return this.topicsFor(query).map((topic) => ({
      ...this.current(topic, now),
      ...(historical ? { history: this.history(topic), earliest: this.db.prepare('SELECT * FROM pet_belief_assertions WHERE topic = ? ORDER BY observed_at, seq LIMIT 1').get(topic) } : {}),
    }))
  }
}

export function formatBeliefContext(items = []) {
  if (!items.length) return ''
  return `CURRENT_UNDERSTANDING (bounded, raw history preserved):
证据优先级：主人当前明确陈述 > 主人历史原话 > 真实系统事件 > 可信旧记录 > 梦/小思考/模型推断。你以前的回答不是证据。
下面 quote 是主人当时的原话，topic/value 只是抽取索引，不能改变 quote 的否定、时间和条件。
supported=有明确陈述支持；contested=多个解释冲突，说明两种情况或请主人澄清；unknown=不知道，不能选择旧值填空；temporary=有期限的临时状态。
confidence 是系统证据等级的界限，不是统计概率。旧记忆不能覆盖当前理解。更正不意味着原话被删除。
历史条目中的 observed_at 是主人说这句话的时间，不能冒充事情实际发生的时间。history 可能只含最近一页和earliest，不能声称穷尽所有变化。
当前问题若只是问句，不构成新证据。只能按下面来源回答“谁告诉你”“为什么”；绝不能引用你的旧回复作为证明。
${JSON.stringify(items)}`
}

// A small local model can ignore even correctly retrieved evidence. For a
// direct question about a tracked state, render the source-backed answer; do
// not allow stylistic completion to replace a known value or invent a past.
export function groundedBeliefReply(query, items = []) {
  const text = String(query ?? '')
  if (!/(什么|哪些|为什么|怎么变|告诉.{0,8}还是|说过.{0,4}还是|确定吗|知道吗|还.{0,12}吗)/u.test(text) || /如果|假如|建议|应该|怎么办|如何/u.test(text)) return null
  const current = /现在|目前|如今/u.test(text)
  const past = /以前|过去|最早|后来|什么时候|怎么变/u.test(text)
  const why = /为什么|依据|告诉.{0,8}还是|说过.{0,4}还是/u.test(text)
  if (!(current || past || why) || !items.length) return null
  if (items.length > 1) return `花花想起了几个相关话题：${items.map(i => i.topic).join('、')}。你指的是哪一个呀？`
  const belief = items[0]
  const quote = a => `“${a.quote}”`
  if (past && belief.history?.entries?.length) {
    const rows = [...new Map([belief.earliest, ...belief.history.entries].filter(Boolean).map(row => [row.id, row])).values()]
      .sort((a, b) => a.observed_at - b.observed_at || a.seq - b.seq)
    const selected = rows.length > 3 ? [rows[0], ...rows.slice(-2)] : rows
    const dates = selected.map(row => `${new Date(row.observed_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}，你告诉我${quote(row)}`).join('；')
    return `关于${belief.topic}，我留下的原话记录是：${dates}。这些是你告诉我的时间。${rows.length > 3 || belief.history.nextBefore ? '这里先列出部分记录。' : ''}`
  }
  if (belief.state === 'unknown') return `关于${belief.topic}，花花现在不确定。${belief.reason === 'temporary-expired' ? '上次说的是临时情况，我不能把它一直当成现在的状态。' : '你后来已经表达了不确定，我不会再拿旧说法替你决定。'}`
  if (belief.state === 'contested') return `关于${belief.topic}，我记得不同说法：${belief.alternatives.slice(-2).map(quote).join('、')}。现在是哪种，我还不确定。`
  const latest = belief.alternatives.at(-1)
  return `关于${belief.topic}，你最近告诉我${quote(latest)}。${belief.state === 'temporary' ? '我先把它理解为临时情况。' : '这是你告诉我的，我目前按这次说法理解。'}`
}
