import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBrain } from '../src/brain/local-brain.js'
import { LocalBrainClient } from '../src/brain/local-brain-client.js'
import { PetMemory } from '../src/memory/pet-memory.js'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'

const health = await fetch('http://127.0.0.1:17862/v1/models').then((response) => response.ok).catch(() => false)
if (!health) {
  console.log('LIVE_CONTEXT_ACCEPTANCE=SKIP reason=local-brain-offline')
} else {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-context-safety-live-'))
  const logs = []
  const logger = { info(message) { logs.push(String(message)); console.log(message) }, warn(message) { logs.push(String(message)); console.log(message) } }
  let memory
  try {
    memory = new PetMemory(root)
    const brain = new LocalBrain({
      memory,
      client: new LocalBrainClient({ requestTimeoutMs: 90_000 }),
      logger,
    })
    const recentMessages = Array.from({ length: 50 }, (_, index) => [
      { role: 'user', content: `主人第${index + 1}轮说：今天回家后我在窗边坐了一会儿，花花在脚边陪着我，我们聊了晚饭和明天的安排。` },
      { role: 'assistant', content: `花花第${index + 1}轮回答：花花听见啦，会安静陪着主人，这只是最近的聊天内容。` },
    ]).flat()
    const result = await brain.reply({
      identity: LI_HUAHUA_IDENTITY,
      state: { mood: 0.8, energy: 0.7, boredom: 0.2, sleepiness: 0.1, attachment: 0.9 },
      userText: '花花，今天还要一起玩吗？',
      recentMessages,
      contextTurns: 50,
    })
    assert.equal(result.ok, true)
    assert.ok(logs.some((line) => line.startsWith('REQUEST_CONTEXT_OVERFLOW=NO ')))
    console.log('LIVE_CONTEXT_ACCEPTANCE=PASS turns=50 backend=accepted')
  } finally {
    try { memory?.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}
