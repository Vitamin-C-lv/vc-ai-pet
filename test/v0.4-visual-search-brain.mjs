import assert from 'node:assert/strict'
import { LocalBrain } from '../src/brain/local-brain.js'

const image = { dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn' }
const requests = []
const brain = new LocalBrain({
  memory: {
    recall() {
      return [
        { content: '我们家的猫叫黑莓', provenance: { evidence: 'confirmed' } },
        { content: '猜测黑莓在雪地里', provenance: { evidence: 'inferred' } },
      ]
    },
  },
  client: {
    async chat(request) {
      requests.push(request)
      return { payload: { choices: [{ message: { content: JSON.stringify(
        requests.length === 1
          ? { visualIds: ['1'] }
          : requests.length === 2
            ? { visualIds: ['{"visualIds": [0]}'] }
            : { observation: '纸箱里有一只猫', action: 'answer', nextVisualId: '', focus: '纸箱里的猫', replyMessages: ['花花找到了。'], match: 'match' },
      ) } }] } }
    },
  },
})

const found = await brain.visualSearch({
  userText: '找黑莓在纸箱里的照片',
  candidates: [{ visualId: 'V0', image }, { visualId: 'V1', image }],
})
assert.deepEqual(found.visualIds, ['V1'], 'numeric IDs from the local model map to candidate IDs')
const nested = await brain.visualSearch({ userText: '找纸箱里的猫', candidates: [{ visualId: 'V0', image }] })
assert.deepEqual(nested.visualIds, ['V0'], 'nested JSON string observed from the local model is decoded')

const verified = await brain.visualStep({
  userText: '找黑莓在纸箱里的照片', image, verifyRecall: true,
})
assert.equal(verified.match, 'match')
const instruction = requests[2].messages[0].content
assert.match(instruction, /我们家的猫叫黑莓/u)
assert.doesNotMatch(instruction, /猜测黑莓在雪地里/u)
assert.match(instruction, /仍须从原图核对/u)

console.log('VISUAL_SEARCH_BRAIN=PASS')
