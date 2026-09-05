import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { startLanServer } from '../src/remote/lan-server.js'
import { readInnerLifeTimeline, publicInnerLifeSummary } from '../src/memory/inner-life-timeline.js'

const sandbox = await mkdtemp(join(tmpdir(), 'vc-ai-pet-inner-life-'))
const runtime = new PetRuntime({ sandboxRoot: sandbox })
let server
try {
  await runtime.initialize()
  const db = runtime.memory.db.db
  assert.deepEqual(readInnerLifeTimeline(db).stats, { totalDream: 0, recentDream: 0, lastDreamAt: null })
  const now = Date.now()
  for (let i = 0; i < 24; i++) {
    runtime.memory.logDream(i === 0 ? 'hidden reasoning: PRIVATE' : '回想了和主人一起度过的时光。', { kind: i % 2 ? 'reflection' : 'dream', derived: i % 3 ? [{ id: 'private-id' }] : [], sourceIds: ['PRIVATE_SOURCE'] }, 'PRIVATE_NOTE')
    // meow-memory's log API timestamps itself. Use fixture SQL to simulate ages.
    db.prepare('UPDATE dream_log SET run_at = ? WHERE rowid = last_insert_rowid()').run(now - i * 86400000)
  }
  const page = readInnerLifeTimeline(db, { now, limit: 5 })
  assert.equal(page.stats.totalDream, 12)
  assert.equal(page.stats.recentDream, 4)
  assert.equal(page.items.length, 5)
  assert.equal(page.nextOffset, 5)
  assert.equal(page.items[0].summary, '')
  assert.equal(page.items[0].understandingCount, 0)
  assert.equal(page.items[1].kind, 'reflection')
  assert.equal(page.items[1].evidence, 'inferred')
  assert.equal(publicInnerLifeSummary('system prompt: private'), '')
  assert.equal(publicInnerLifeSummary('token=abc123'), '')
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE|sourceIds|private-id|changes|prompt/)
  server = await startLanServer({ runtime, assetRoot: new URL('../assets/runtime/', import.meta.url).pathname, port: 0, logger: { info() {} } })
  const base = `http://127.0.0.1:${server.address().port}`
  const api = await fetch(`${base}/api/inner-life`)
  assert.equal(api.status, 200)
  const data = await api.json()
  assert.equal(data.items.length, 20)
  assert.equal(data.nextOffset, 20)
  assert.equal((await fetch(`${base}/api/inner-life?offset=-1`)).status, 400)
  assert.equal((await (await fetch(`${base}/api/inner-life?offset=20`)).json()).items.length, 4)
  const html = await (await fetch(base)).text()
  assert.ok(html.indexOf('inner-life-open') < html.indexOf('pet-card'))
  assert.match(html, /近 7 天梦境|累计梦境/)
  const mobile = await readFile(new URL('../src/remote/mobile-ui/mobile.js', import.meta.url), 'utf8')
  assert.match(mobile, /💭 小思考/)
  assert.match(mobile, /这次只是整理了一些最近的事情/)
  assert.match(mobile, /summary\.textContent =/)
  assert.doesNotMatch(mobile, /summary\.innerHTML/)
  if (process.argv.includes('--serve')) {
    console.log(`FIXTURE_UI_URL=${base}`)
    await new Promise(resolve => process.once('SIGTERM', resolve))
  }
  console.log('PASS inner-life: safe DTO, real SQLite stats, time range, pagination, LAN endpoint, Play entry and empty conclusions')
} finally {
  if (server) { const closed = once(server, 'close'); server.close(); await closed }
  runtime.close()
  await rm(sandbox, { recursive: true, force: true })
}
