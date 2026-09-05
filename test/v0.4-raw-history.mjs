import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConversationStore } from '../src/conversation/conversation-store.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-raw-history-'))
let store
try {
  const messages = Array.from({ length: 510 }, (_, i) => ({ id: `legacy-${i}`, role: i % 2 ? 'assistant' : 'user', text: `untouched legacy text ${i}`, timestamp: i + 1, attachment: null }))
  await writeFile(join(root, 'conversation-store.json'), JSON.stringify({ version: 1, messages, attachments: [] }))
  store = new ConversationStore(root)
  await store.initialize()
  assert.deepEqual(await store.sourceMessage('legacy-0'), messages[0], 'import before 500 truncation')
  assert.equal((await store.listForRecentVisualRecall()).length, 500)
  assert.deepEqual(await store.list(0), [])
  assert.deepEqual(await store.listForRecentVisualRecall(0), [])
  const original = ' exact spacing\n' + 'raw-history'.repeat(130)
  const appended = await store.appendMessage({ role: 'user', text: original })
  assert.equal((await store.sourceMessage(appended.id)).text, original)
  assert.ok((await store.list(1))[0].text.length <= 1200)
  const p1 = await store.rawHistory({ limit: 200 })
  const p2 = await store.rawHistory({ afterId: p1.at(-1).id, limit: 200 })
  assert.equal(p1[0].id, 'legacy-0')
  assert.equal(p2[0].id, 'legacy-200')
  store.close()
  store = new ConversationStore(root)
  await store.initialize()
  assert.deepEqual(await store.sourceMessage('legacy-0'), messages[0])
  assert.equal((await store.sourceMessage(appended.id)).text, original)
  assert.equal(store.archive.prepare('SELECT count(*) AS n FROM raw_messages').get().n, 511, 'restart import is idempotent')
  console.log('PASS raw history: legacy import, exact text, retention beyond 500, bounded pagination, restart and zero-limit')
} finally {
  store?.close()
  await rm(root, { recursive: true, force: true })
}
