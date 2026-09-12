/**
 * Explicit Memory Controller — turns a one-off "记住这个" into a durable fact
 * that survives the rest of the conversation.
 *
 * Why intent has to be carried forward:
 *
 * The acceptance case is "记住我们家的猫叫黑莓" and then, one turn later,
 * "我们家的猫叫黑莓". The second sentence carries no keyword at all, so the
 * keyword rule finds nothing, the gate falls through to `skipped`, and the pet
 * forgets the cat it was just told about. A keyword-only detector structurally
 * cannot cover the way owners actually speak: they give the instruction once
 * and then talk about the thing.
 *
 * So an explicit request is treated as an *establishment act*. It is remembered
 * for a bounded window, and the next owner assertion about the same subject is
 * written durably as well — with both quotes accumulated as verbatim evidence,
 * never a model summary.
 *
 * Safety properties:
 * - The window is closed on the first successful write, so intent can never
 *   leak across unrelated topics for the rest of the session.
 * - A forget request ("不要记住这个") and an opt-out clear the window.
 * - Only assertions that overlap the original claim pass the `followUp(minScore)`
 *   threshold; the threshold is supplied by the caller so the lexical decision
 *   stays with the tokenizer that the rest of the pipeline uses.
 * - Nothing here writes memory. The controller only decides *what* should be
 *   validated; `MemoryGate` keeps every veto it had.
 */

import { detectExplicitMemoryRequest, explicitMemoryContent, explicitMemoryStatement } from '../brain/memory-candidate.js'

export const EXPLICIT_MEMORY_INTENT_TTL_MS = 10 * 60 * 1000
export const EXPLICIT_MEMORY_FOLLOW_UP_MIN_SCORE = 0.5
const MAX_CLAIMS = 4

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

/**
 * Extract the informative tokens from a claim. Mirrors the conservative style
 * of the rest of the pipeline: short CJK n-grams plus latin/digit words, with
 * boilerplate removed so "记住" itself can never be the thing that matches.
 */
export function claimTokens(value) {
  const text = clean(value, 200)
  if (!text) return new Set()
  const tokens = new Set()
  const compact = text.replace(/[\s，,。.:：;；!！?？、"'“”‘’()（）]/gu, '')
  const stripped = compact.replace(/记住|记下来|记一下|记着|记好|不要忘|别忘了|别忘记|以后叫|以后知道|知道|记得|主人|花花|李花花/gu, '')
  for (const match of stripped.matchAll(/[\u4e00-\u9fff]{2,4}/gu)) {
    const run = match[0]
    for (let size = 2; size <= Math.min(4, run.length); size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) tokens.add(run.slice(start, start + size))
    }
  }
  for (const match of stripped.matchAll(/[A-Za-z0-9]{2,}/gu)) tokens.add(match[0].toLowerCase())
  return tokens
}

/**
 * Fraction of the follow-up's informative tokens that also appear in the
 * established claim. Deliberately asymmetric: it asks "is this follow-up about
 * the thing I was told to remember?", not "are these two strings similar?".
 */
export function claimOverlap(followUpText, claimText) {
  const follow = claimTokens(followUpText)
  if (follow.size === 0) return 0
  const claim = claimTokens(claimText)
  if (claim.size === 0) return 0
  let hit = 0
  for (const token of follow) if (claim.has(token)) hit += 1
  return hit / follow.size
}

export class ExplicitMemoryController {
  constructor({
    ttlMs = EXPLICIT_MEMORY_INTENT_TTL_MS,
    limit = 8,
    now = () => Date.now(),
    containsSensitive = (text) => /密码|password|token|api\s*key|apikey|密钥|secret|验证码/iu.test(String(text ?? '')),
  } = {}) {
    this.ttlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : EXPLICIT_MEMORY_INTENT_TTL_MS
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : 8
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.containsSensitive = typeof containsSensitive === 'function' ? containsSensitive : () => false
    this.intents = []
    this.claims = []
  }

  #pruneIntents(now) {
    this.intents = this.intents.filter((intent) => intent.expiresAt > now)
  }

  /**
   * Resolve how this turn should be treated.
   *
   * @param {string} userText
   * @param {{ followUpMinScore?: number }} [options]
   * @returns {{
   *   decision: 'establish'|'follow-up'|'none',
   *   detection: object,
   *   evidence: string|null,
   *   accumulatedEvidence: string|null,
   *   priority: 'HIGH'|null,
   *   source: 'USER_EXPLICIT'|null,
   *   phrase: string|null,
   * }}
   */
  resolve(userText, { followUpMinScore = EXPLICIT_MEMORY_FOLLOW_UP_MIN_SCORE } = {}) {
    const text = clean(userText, 1200)
    if (!text) {
      return { decision: 'none', detection: detectExplicitMemoryRequest(''), evidence: null, accumulatedEvidence: null, priority: null, source: null, phrase: null }
    }

    const detection = detectExplicitMemoryRequest(text)
    const now = this.now()

    // An opt-out or forget request closes every pending window: the owner has
    // explicitly revoked the instruction.
    if (detection.optOut) {
      this.intents = []
      this.claims = []
      return { decision: 'none', detection, evidence: null, accumulatedEvidence: null, priority: null, source: null, phrase: null }
    }

    if (this.containsSensitive(text)) {
      return { decision: 'none', detection, evidence: null, accumulatedEvidence: null, priority: null, source: null, phrase: null }
    }

    if (detection.explicit) {
      this.#pruneIntents(now)
      // Keep the directive-free claim: the verbatim quote is what recall
      // indexes, and "记住…" carries no information about the subject.
      const evidence = explicitMemoryStatement(text) || text
      this.intents.push({
        phrase: detection.phrase ?? null,
        evidence,
        expiresAt: now + this.ttlMs,
      })
      while (this.intents.length > this.limit) this.intents.shift()
      return {
        decision: 'establish',
        detection,
        evidence,
        accumulatedEvidence: this.#accumulated(evidence),
        content: explicitMemoryContent(evidence),
        level: detection.stableIntent ? 'user' : 'fact',
        priority: 'HIGH',
        source: 'USER_EXPLICIT',
        phrase: detection.phrase ?? null,
      }
    }

    this.#pruneIntents(now)
    if (this.intents.length === 0) {
      return { decision: 'none', detection, evidence: null, accumulatedEvidence: null, content: null, level: null, priority: null, source: null, phrase: null }
    }

    const candidate = text
    for (const intent of this.intents) {
      const overlap = claimOverlap(candidate, intent.evidence)
      if (overlap < followUpMinScore) continue
      // The window deliberately stays open for the rest of the TTL. Owners
      // restate a fact several times ("我们家的猫叫黑莓" ... "黑莓是只猫"), and
      // closing on the first write dropped every later restatement. Over-reach
      // is bounded by the lexical overlap threshold plus deduplication in the
      // gate, not by closing early: an unrelated sentence scores far below it.
      const accumulated = this.#accumulated(candidate)
      return {
        decision: 'follow-up',
        detection,
        evidence: candidate,
        accumulatedEvidence: accumulated,
        content: explicitMemoryContent(accumulated ?? candidate),
        // A follow-up states a fact in the owner's own words; it is only
        // promoted to `user` when the original instruction was first-person.
        level: /^我(?!们)/u.test(intent.evidence) ? 'user' : 'fact',
        priority: 'HIGH',
        source: 'USER_EXPLICIT',
        phrase: intent.phrase,
      }
    }

    return { decision: 'none', detection, evidence: null, accumulatedEvidence: null, content: null, level: null, priority: null, source: null, phrase: null }
  }

  /**
   * Every verbatim claim seen so far, joined. Recall works on the owner's own
   * words: asking "猫叫什么" only finds the cat if the pet kept the sentence
   * where the cat was actually named.
   */
  #accumulated(latest) {
    const claim = clean(latest, 200)
    if (!claim) return null
    // Repeating the same sentence must not inflate the stored quote: recall
    // scores grow with term frequency, so duplicated evidence would make a
    // repeated sentence look more important than it is.
    this.claims = [...this.claims.filter((existing) => existing !== claim), claim].slice(-MAX_CLAIMS)
    return this.claims.join('；')
  }

  /**
   * Close the current window early. The window normally expires on its own TTL;
   * this is the explicit kill switch (used by callers that know the topic moved
   * on) — it is deliberately NOT called after a successful write, because a
   * restatement in the next turn is the normal way owners speak.
   */
  consume() {
    this.intents = []
  }

  snapshot() {
    const now = this.now()
    return {
      pending: this.intents.filter((intent) => intent.expiresAt > now).length,
      claims: [...this.claims],
    }
  }

  clear() {
    this.intents = []
    this.claims = []
  }
}
