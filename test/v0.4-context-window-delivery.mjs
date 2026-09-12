import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { RecentConversation, RECENT_CONVERSATION_DEFAULT_MAX_TURNS } from '../src/conversation/recent-conversation.js'
import { SHORT_TERM_CONTEXT_TURNS, selectContextTurns } from '../src/conversation/context-budget.js'
import {
  PROMPT_DEFAULT_CONTEXT_TURNS,
  buildPetMessages,
  formatConversationEvidenceBoundary,
} from '../src/brain/prompt-builder.js'

/**
 * Does the working-memory window actually reach the model?
 *
 * This suite exists because for a while it did not. `RecentConversation` kept
 * twelve turns and `prompt-builder` kept `.slice(-24)` messages, and those two
 * numbers were unrelated to each other and to anything configurable. Raising the
 * configured window changed nothing the model could see: the transcript was cut
 * to 24 messages on the way out. The window is now a parameter, and these are
 * the assertions that keep "advertised window" equal to "delivered window".
 */

const OWNER_TURNS = 60
// Sanity ceiling for the invalid-input cases below.
const PROMPT_MAX_TURNS_SANITY = 400

function turnsFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    user: `主人第${index + 1}句话`,
    assistant: `花花第${index + 1}句回答`,
  }))
}

function messagesFor(count) {
  return turnsFor(count).flatMap(({ user, assistant }) => [
    { role: 'user', content: user },
    { role: 'assistant', content: assistant },
  ])
}

/** The dialogue window the model receives, excluding the current utterance. */
function deliveredWindow(contextTurns, messages = messagesFor(OWNER_TURNS)) {
  const built = buildPetMessages({
    identity: {},
    state: {},
    userText: '现在呢',
    recentMessages: messages,
    contextTurns,
  })
  const dialogue = built.filter((message) => message.role === 'user' || message.role === 'assistant')
  return { built, dialogue, window: dialogue.slice(0, -1) }
}

// --- the target is 50 turns and nothing silently caps it ---------------------

assert.equal(SHORT_TERM_CONTEXT_TURNS, 50, 'the working window target is 50 turns')
assert.equal(RECENT_CONVERSATION_DEFAULT_MAX_TURNS, 50)
assert.equal(PROMPT_DEFAULT_CONTEXT_TURNS, 50, 'the prompt builder must default to the same window')

{
  const { window, dialogue } = deliveredWindow(50)
  assert.equal(window.length, 100, `50 turns must deliver 100 messages, got ${window.length}`)
  assert.equal(dialogue.length, 101, 'the current utterance is the 101st dialogue message')
  assert.equal(window[0].content, '主人第11句话', 'the window must start 50 turns back, not 12')
}

// --- the window is genuinely configurable, not a different hidden constant ---

{
  const twelve = deliveredWindow(12).window
  assert.equal(twelve.length, 24)
  assert.ok(
    !twelve.some((message) => message.content === '主人第11句话'),
    'a 12-turn window must not contain the 50th-from-last turn',
  )

  const twentyFour = deliveredWindow(24).window
  assert.equal(twentyFour.length, 48, 'the old hard-coded 24 messages is now 24 turns')

  // More turns than the transcript: keep everything, invent nothing.
  const sixty = deliveredWindow(60).window
  assert.equal(sixty.length, 120)
  assert.equal(sixty[0].content, '主人第1句话')
}

// --- the source map must describe exactly what was sent ----------------------

{
  const messages = messagesFor(OWNER_TURNS)
  for (const turns of [12, 24, 50]) {
    const boundary = formatConversationEvidenceBoundary(messages, { maxTurns: turns })
    const entries = (boundary.match(/- RECENT_MESSAGE_\d+/gu) ?? []).length
    assert.equal(
      entries,
      turns * 2,
      `source map must match the delivered window for ${turns} turns, got ${entries}`,
    )
  }

  // A narrower map than the transcript would mislabel the oldest visible turn.
  const built = buildPetMessages({
    identity: {},
    state: {},
    userText: '现在呢',
    recentMessages: messages,
    contextTurns: 50,
  })
  const mapEntries = (built[0].content.match(/- RECENT_MESSAGE_\d+/gu) ?? []).length
  const delivered = built.filter((message) => message.role === 'user' || message.role === 'assistant').length - 1
  assert.equal(mapEntries, delivered, 'the source map and the transcript must agree')
}

// --- invalid windows degrade instead of throwing -----------------------------

{
  for (const bad of [0, -1, 1.5, 'abc', null, undefined, NaN, Infinity]) {
    assert.doesNotThrow(() => deliveredWindow(bad), `contextTurns=${String(bad)} must not throw`)
    const { window } = deliveredWindow(bad)
    assert.ok(window.length >= 2, `contextTurns=${String(bad)} must still deliver something`)
    assert.ok(window.length <= PROMPT_MAX_TURNS_SANITY, `contextTurns=${String(bad)} must stay bounded`)
  }
  const huge = deliveredWindow(1e9).window
  assert.equal(huge.length, OWNER_TURNS * 2, 'an absurd window is clamped to the available transcript')
}

// --- end to end: the runtime really hands a growing window to the brain ------

async function endToEnd() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-context-delivery-'))
  const runtime = new PetRuntime({ sandboxRoot: root })
  const seen = []
  try {
    await runtime.initialize()
    runtime.brain = {
      async reply({ recentMessages }) {
        seen.push(recentMessages?.length ?? 0)
        return {
          ok: true,
          text: '嗯嗯。',
          replyMessages: ['嗯嗯。'],
          memoryCandidate: null,
          rawMemoryCandidate: null,
          beliefCandidates: [],
          memoryDecision: 'model-skip',
          structured: true,
        }
      },
    }

    for (let index = 0; index < 20; index += 1) {
      const turn = await runtime.chat(`主人第${index + 1}句闲聊`)
      assert.equal(turn.ok, true)
    }

    // Each turn contributes two messages, so the window grows 0, 2, 4, ...
    assert.deepEqual(seen.slice(0, 3), [0, 2, 4], `the window must grow with the conversation, got ${seen.slice(0, 3)}`)
    assert.equal(seen.at(-1), 38, 'twenty turns deliver 38 previous messages')
    // The point of the fix: the window is no longer pinned to 24 messages.
    assert.ok(
      seen.some((count) => count > 24),
      `the window must be able to exceed the old 24-message cap, saw max ${Math.max(...seen)}`,
    )
    assert.ok(
      seen.every((count) => count <= SHORT_TERM_CONTEXT_TURNS * 2),
      'the window must never exceed the configured budget in turns',
    )
    console.log('CONTEXT_WINDOW_DELIVERED_TO_BRAIN=PASS max=' + Math.max(...seen))
  } finally {
    try { runtime.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

// --- the character budget trims by priority, and says what it dropped --------

{
  // Long turns and a small budget, so trimming is genuinely forced: the previous
  // version of this block used short turns and never actually dropped anything.
  const long = Array.from({ length: 50 }, (_, index) => ({
    user: `主人第${index + 1}句话` + '闲聊内容'.repeat(40),
    assistant: `花花第${index + 1}句回答` + '回应内容'.repeat(40),
  }))
  const budget = 3_000
  const result = selectContextTurns(long, { maxTurns: 50, maxChars: budget, reservedTurns: 6 })
  const kept = new Set(result.turns.map((turn) => turn.user))
  const lastSix = long.slice(-6).map((turn) => turn.user)

  assert.ok(result.turns.length < 50, `trimming must actually happen, kept ${result.turns.length} of 50`)
  assert.ok(result.turns.length >= 6, 'the reserved recent turns are never dropped')
  for (const user of lastSix) {
    assert.ok(kept.has(user), `reserved turn must survive trimming: ${user}`)
  }
  // The reserve is untouchable, so the budget yields to it — and says so.
  assert.ok(
    result.approxChars <= budget || result.reasons.reservedExceedsBudget === true,
    'a trim must respect the budget or declare that the reserve alone exceeds it',
  )
  // Order is preserved: trimming removes entries, it does not reorder them.
  const order = result.turns.map((turn) => long.indexOf(turn))
  assert.deepEqual(order, [...order].sort((left, right) => left - right), 'kept turns must stay in time order')
  console.log('CONTEXT_BUDGET_TRIM_KEPT=' + result.turns.length + '/50 RESERVE_KEPT=YES DROPPED=' + result.dropped.length)
}

// --- RecentConversation restores the whole window ----------------------------

{
  const recent = new RecentConversation()
  for (const turn of turnsFor(50)) recent.append(turn.user, turn.assistant)
  assert.equal(recent.size, 50, 'the short-term store must hold the full 50 turns')
  assert.equal(recent.messages().length, 100)
  const snapshot = recent.snapshot()
  assert.equal(snapshot[0].user, '主人第1句话', 'the oldest turn must not be silently dropped')
}

await endToEnd()
console.log('VC_AI_PET_V0_4_CONTEXT_WINDOW_DELIVERY=PASS')
