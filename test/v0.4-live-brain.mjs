import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { LocalBrainClient } from '../src/brain/local-brain-client.js'

// Explicit opt-in: all life records go to a disposable Pet sandbox. This uses
// only the existing loopback Brain contract and never a production Pet route.
if (!process.argv.includes('--live')) {
  console.log('SKIP live Local Brain (run with --live to use the local service)')
} else {
  const sandbox = await mkdtemp(join(tmpdir(), 'vc-ai-pet-live-cognition-'))
  const runtime = new PetRuntime({ sandboxRoot: sandbox })
  try {
    await runtime.initialize()
    runtime.brain.client = new LocalBrainClient({ requestTimeoutMs: 45000 })
    const prior = await runtime.conversationStore.appendMessage({ role: 'user', text: '我最喜欢蓝色。', timestamp: Date.now() - 86400000 })
    runtime.memory.beliefs.consider([{ topic: '最喜欢的颜色', value: '蓝色', quote: prior.text, change: 'assert' }], prior)
    const text = '其实我现在最喜欢白色。'
    const result = await runtime.chat(text)
    if (!result.ok) {
      console.log(`LIVE_INTEGRATION=UNAVAILABLE reason=${result.reason}`)
      process.exitCode = 2
    } else {
      const beliefs = runtime.memory.beliefs.context('最喜欢的颜色')
      assert.ok(beliefs.some((b) => b.alternatives.some((a) => a.quote.includes('白色'))), 'real Brain must produce an accepted literal belief')
      assert.equal(runtime.memory.beliefs.history('最喜欢的颜色').entries.length, 2, 'real Brain reuses the existing topic')
      const recall = await runtime.chat('花花，我现在最喜欢什么颜色？')
      assert.equal(recall.ok, true)
      assert.match(recall.text, /白色/u)
      console.log(`LIVE_INTEGRATION=PASS beliefs=${beliefs.length} durationMs=${result.reasoning?.durationMs}`)
    }
  } catch (error) {
    console.log(`LIVE_INTEGRATION=FAILED code=${error.code ?? error.name} message=${error.message}`)
    process.exitCode = 1
  } finally {
    runtime.close()
    await rm(sandbox, { recursive: true, force: true })
  }
}
