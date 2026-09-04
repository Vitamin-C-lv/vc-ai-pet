import assert from 'node:assert/strict'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

function memorySnapshot(runtime) {
  const levels = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
  return JSON.stringify(levels.flatMap((level) => runtime.memory.db.list(level, {})))
}

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-thinking-duration-'))
const legacyRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-thinking-duration-legacy-'))
let runtime = null
let reloaded = null
try {
  runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  runtime.memoryGate = { consider: () => ({ status: 'skipped', reason: 'duration-test' }) }
  runtime.brain = {
    reply: async () => ({
      ok: true,
      text: '花花收到啦。',
      rawMemoryCandidate: null,
      reasoning: { effort: 'low', durationMs: 1234, chainOfThought: 'never persist this' },
    }),
  }

  const memoryBefore = memorySnapshot(runtime)
  const live = await runtime.chat('时长持久化测试')
  assert.deepEqual(live.reasoning, { effort: 'low', durationMs: 1234 })
  assert.equal(memorySnapshot(runtime), memoryBefore)
  console.log('THINKING_DURATION_LIVE=PASS')

  const liveHistory = await runtime.conversationHistory()
  assert.deepEqual(liveHistory.at(-1).reasoning, { effort: 'low', durationMs: 1234 })
  assert.equal(Object.hasOwn(liveHistory.at(-1).reasoning, 'chainOfThought'), false)
  const persisted = JSON.parse(await readFile(join(root, 'conversation-store.json'), 'utf8'))
  assert.deepEqual(persisted.messages.at(-1).reasoning, { effort: 'low', durationMs: 1234 })
  assert.doesNotMatch(JSON.stringify(persisted), /data:image|chainOfThought/u)
  console.log('THINKING_DURATION_PERSISTED=YES')
  console.log('THINKING_DURATION_STORAGE=CONVERSATION_METADATA_ONLY')

  runtime.close()
  runtime = null
  reloaded = new PetRuntime({ sandboxRoot: root })
  await reloaded.initialize()
  const refreshedHistory = await reloaded.conversationHistory()
  assert.deepEqual(refreshedHistory.at(-1).reasoning, { effort: 'low', durationMs: 1234 })
  console.log('THINKING_DURATION_AFTER_REFRESH=PASS')

  const legacyStore = new ConversationStore(legacyRoot)
  await legacyStore.initialize()
  await legacyStore.appendMessage({ role: 'user', text: '旧消息', timestamp: 1 })
  await legacyStore.appendMessage({ role: 'assistant', text: '旧回答', timestamp: 2 })
  const legacyHistory = await legacyStore.history()
  assert.equal(Object.hasOwn(legacyHistory[1], 'reasoning'), false)
  console.log('OLD_MESSAGES_WITHOUT_DURATION=PASS')

  const mobileJs = await readFile(join(process.cwd(), 'src/remote/mobile-ui/mobile.js'), 'utf8')
  assert.match(mobileJs, /const petMessage = role === 'pet' \|\| role === 'assistant'/u)
  assert.match(mobileJs, /formatThinkingDuration\(reasoning\?\.durationMs\)/u)
  console.log('HISTORY_DURATION_UI=PASS')
  console.log('MEMORY_IMPACT=NO')
} finally {
  reloaded?.close()
  runtime?.close()
  await rm(root, { recursive: true, force: true })
  await rm(legacyRoot, { recursive: true, force: true })
}

console.log('FINAL_STATUS=VC_AI_PET_THINKING_DURATION_PERSISTENCE_PASS')
