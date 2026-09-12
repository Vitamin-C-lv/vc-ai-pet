import assert from 'node:assert/strict'

import {
  ExplicitMemoryController,
  EXPLICIT_MEMORY_INTENT_TTL_MS,
  claimOverlap,
  claimTokens,
} from '../src/memory/explicit-memory-controller.js'

/**
 * Explicit Memory Controller — the piece that makes a one-off instruction stick.
 *
 * The real failure this guards: the owner says "记住我们家的猫叫黑莓" and then
 * "我们家的猫叫黑莓". The second sentence has no keyword, so a keyword-only
 * detector finds nothing and the pet forgets the cat it was just told about.
 *
 * Failures here are silent. Nothing throws, the pet just quietly stops
 * remembering, which is exactly the bug the owner reported.
 */

function controllerWith({ now = () => 1_000_000 } = {}) {
  return new ExplicitMemoryController({ now })
}

// --- tokenisation / overlap -------------------------------------------------

assert.ok(claimTokens('我们家的猫叫黑莓').size > 0, 'tokens must not be empty')
assert.equal(claimTokens('').size, 0, 'empty text has no tokens')
assert.equal(claimOverlap('', '我们家的猫叫黑莓'), 0, 'empty follow-up cannot match')
assert.equal(claimOverlap('我们家的猫叫黑莓', ''), 0, 'empty claim cannot match')

// The directive itself must never be the thing that matches, or every
// "记住..." turn would look related to every other "记住..." turn.
const directiveOnly = claimOverlap('记住', '记住我们家的猫叫黑莓')
assert.ok(directiveOnly < 0.5, `bare directive must not match, got ${directiveOnly}`)

const sameClaim = claimOverlap('我们家的猫叫黑莓', '记住我们家的猫叫黑莓')
assert.ok(sameClaim >= 0.5, `a restatement must match, got ${sameClaim}`)

const unrelated = claimOverlap('今天天气不错', '记住我们家的猫叫黑莓')
assert.ok(unrelated < 0.5, `an unrelated sentence must not match, got ${unrelated}`)

// --- establish / follow-up / none -------------------------------------------

{
  const controller = controllerWith()
  const first = controller.resolve('记住我们家的猫叫黑莓')
  assert.equal(first.decision, 'establish')
  assert.equal(first.priority, 'HIGH')
  assert.equal(first.source, 'USER_EXPLICIT')
  assert.equal(first.evidence, '我们家的猫叫黑莓', 'the directive must not be part of the evidence')
  assert.ok(
    !/你要记住|记下来|记一下/.test(first.content),
    `stored content must not keep the spoken directive, got ${first.content}`,
  )

  const second = controller.resolve('我们家的猫叫黑莓')
  assert.equal(second.decision, 'follow-up', 'a restatement must be covered by the live instruction')
  assert.equal(second.priority, 'HIGH', 'a follow-up keeps HIGH priority')
  assert.ok(
    second.accumulatedEvidence.includes('我们家的猫叫黑莓'),
    `accumulated evidence must keep the owner's words, got ${second.accumulatedEvidence}`,
  )

  // An unrelated sentence must not be swept up by the open window.
  const noise = controller.resolve('今天天气不错')
  assert.equal(noise.decision, 'none', 'an unrelated turn must not become a memory')
}

// --- the window must expire -------------------------------------------------

{
  let now = 1_000_000
  const controller = new ExplicitMemoryController({ now: () => now })
  controller.resolve('记住我们家的猫叫黑莓')
  now += EXPLICIT_MEMORY_INTENT_TTL_MS + 1
  const afterTtl = controller.resolve('我们家的猫叫黑莓')
  assert.equal(afterTtl.decision, 'none', 'an expired instruction must stop covering later turns')
}

// --- the window must expire even without another explicit request -----------

{
  let now = 1_000_000
  const controller = new ExplicitMemoryController({ now: () => now })
  controller.resolve('记住我们家的猫叫黑莓')
  assert.equal(controller.snapshot().pending, 1)
  now += EXPLICIT_MEMORY_INTENT_TTL_MS + 1
  assert.equal(controller.snapshot().pending, 0, 'snapshot must prune expired intents')
}

// --- opt-out revokes the instruction ----------------------------------------

{
  const controller = controllerWith()
  controller.resolve('记住我们家的猫叫黑莓')
  assert.equal(controller.snapshot().pending, 1)

  const revoke = controller.resolve('不要记住这个')
  assert.equal(revoke.decision, 'none')
  assert.equal(controller.snapshot().pending, 0, 'a forget request must close the window')

  const afterwards = controller.resolve('我们家的猫叫黑莓')
  assert.equal(afterwards.decision, 'none', 'a revoked instruction must not keep writing')
}

// --- sensitive text is never a claim ----------------------------------------

{
  const controller = controllerWith()
  const sensitive = controller.resolve('记住我的密码是 abc123')
  assert.equal(sensitive.decision, 'none', 'credentials must never enter the memory path')
  assert.equal(controller.snapshot().pending, 0)
}

// --- repeated restatements do not inflate the stored quote -------------------

{
  const controller = controllerWith()
  controller.resolve('记住我们家的猫叫黑莓')
  controller.resolve('我们家的猫叫黑莓')
  controller.resolve('我们家的猫叫黑莓')
  const claims = controller.snapshot().claims
  assert.equal(
    new Set(claims).size,
    claims.length,
    `duplicate restatements must not be stored twice, got ${JSON.stringify(claims)}`,
  )
}

// --- one instruction covers only what it is about ---------------------------

{
  const controller = controllerWith()
  controller.resolve('记住我们家的猫叫黑莓')
  assert.equal(controller.resolve('黑莓今天睡沙发').decision, 'none', 'an unrelated claim about the same pet is not covered')
  assert.equal(controller.resolve('我们家的猫叫黑莓').decision, 'follow-up', 'the original claim is still covered')
}

// --- claimTokens stays bounded on pathological input ------------------------

{
  const long = '猫'.repeat(5_000)
  const tokens = claimTokens(long)
  assert.ok(tokens.size > 0 && tokens.size < 20, `token set must stay bounded, got ${tokens.size}`)
  assert.doesNotThrow(() => claimTokens(null))
  assert.doesNotThrow(() => claimTokens(undefined))
  assert.doesNotThrow(() => claimOverlap(null, null))
}

console.log('VC_AI_PET_V0_4_EXPLICIT_MEMORY_CONTROLLER=PASS')
