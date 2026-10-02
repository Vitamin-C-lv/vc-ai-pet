import assert from 'node:assert/strict'
import { LocalBrain } from '../src/brain/local-brain.js'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'

const requests = []
let output = { send: true, text: '汪！主人有空陪花花聊一会儿吗～' }
const brain = new LocalBrain({ memory: {}, client: { chat: async request => {
  requests.push(request)
  return { payload: { choices: [{ message: { content: JSON.stringify(output) } }] } }
} } })
const input = { identity: LI_HUAHUA_IDENTITY, state: { current: 'bored', energy: 0.8 },
  recentMessages: [{ role: 'user', content: '晚点陪你玩' }], idleMs: 7_200_000, now: Date.parse('2026-10-02T04:00:00Z') }
const result = await brain.proactiveMessage(input)
assert.equal(result.send, true)
assert.equal(result.text, output.text)
assert.equal(result.reasoning.effort, 'medium')
assert.equal(requests[0].reasoningStage, 'proactive')
assert.equal(requests[0].maxTokens, 1792)
assert.ok(requests[0].messages[0].content.includes('晚点陪你玩'))
output = { send: false, text: '' }
assert.equal((await brain.proactiveMessage(input)).send, false)
output = { send: true, text: '' }
await assert.rejects(brain.proactiveMessage(input), { code: 'PET_LOCAL_BRAIN_BAD_PROACTIVE_MESSAGE' })
output = { send: true, text: '过'.repeat(121) }
await assert.rejects(brain.proactiveMessage(input), { code: 'PET_LOCAL_BRAIN_BAD_PROACTIVE_MESSAGE' })
console.log('PASS proactive brain: medium-budget JSON, bounded message, decline and invalid output')
