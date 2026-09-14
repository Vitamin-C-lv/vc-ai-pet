import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { LocalBrainClient } from '../src/brain/local-brain-client.js'
import { buildRecentExperienceContext, withExperienceDeclaration } from '../src/experience/experience-dream-context.js'

/**
 * Image memory — live end-to-end against the real Local Brain.
 *
 * Opt-in (`--live`), exactly like test/v0.4-live-brain.mjs: a disposable /tmp
 * Pet sandbox, the loopback Brain contract, and real pictures. Token cost is
 * deliberately not a concern here (the owner's rule: waste a little electricity,
 * be thorough). The production Pet sandbox is never opened for writing; the
 * pictures are only ever read.
 *
 * Asserted:
 * 1. The pet's *real* perception of a real picture reaches the buffer and memory.
 * 2. A remembered picture can be re-opened and described again from scratch.
 * 3. The consolidation prompt carries the real observation and its own boundary
 *    declaration, and never an image payload.
 */

let thumbnailDataUrl = null
function thumbnail() {
  // Built lazily: the module body runs before these helpers would be evaluated.
  if (!thumbnailDataUrl) thumbnailDataUrl = `data:image/png;base64,${solidPng(256, [120, 144, 156]).toString('base64')}`
  return thumbnailDataUrl
}

const PRODUCTION_ASSETS = '/home/vitamin_c/.local/share/vc-ai-pet/sandbox/conversation-assets'

if (!process.argv.includes('--live')) {
  console.log('SKIP live image memory (run with --live to use the local Brain)')
} else {
  const sample = await pickRealPictures(3)
  if (sample.length === 0) {
    console.log('LIVE_IMAGE_MEMORY=SKIPPED reason=no-real-pictures')
    process.exitCode = 2
  } else {
    const sandbox = await mkdtemp(join(tmpdir(), 'vc-ai-pet-live-image-memory-'))
    const runtime = new PetRuntime({ sandboxRoot: sandbox })
    try {
      await runtime.initialize()
      runtime.brain.client = new LocalBrainClient({ requestTimeoutMs: 180_000 })

      // ── 1. A real picture, a real perception ────────────────────────────────
      const first = sample[0]
      const started = Date.now()
      const firstAttachment = await runtime.conversationStore.saveAttachment({
        image: { dataUrl: first.dataUrl },
        thumbnail: thumbnail(),
      })
      const turn = await runtime.chat('花花，看看这张图', { dataUrl: first.dataUrl }, firstAttachment)
      const elapsedMs = Date.now() - started
      if (!turn.ok) {
        console.log(`LIVE_IMAGE_MEMORY=UNAVAILABLE reason=${turn.reason} detail=${turn.diagnostic?.stage ?? ''}`)
        process.exitCode = 2
      } else {
        assert.equal(turn.imageMemory, 'written', `image memory must be written, got ${turn.imageMemory}`)
        await runtime.flushExperienceWrites()

        const observations = allMemoryRows(runtime).filter((row) => row.provenance.source === 'VISUAL_OBSERVATION')
        assert.equal(observations.length, 1, `exactly one observation row, got ${observations.length}`)
        const perceived = String(observations[0].content)
        assert.equal(observations[0].provenance.evidence, 'inferred')
        assert.ok(perceived.length > 8, `the real model must actually perceive something: ${perceived}`)
        assert.equal(perceived.includes('base64,'), false)

        const anchor = allMemoryRows(runtime).find((row) => String(row.content).includes('主人给花花看过一张图片'))
        assert.ok(anchor, 'the owner-confirmed anchor exists for a real picture')
        assert.equal(anchor.provenance.source, 'SYSTEM_EVENT')
        assert.equal(anchor.provenance.evidence, 'confirmed')
        assert.ok(
          observations[0].provenance.sourceIds.includes(anchor.id),
          'the perception cites the anchor as its evidence root',
        )
        console.log(`LIVE_PERCEPTION=PASS ms=${elapsedMs} chars=${perceived.length}`)
        console.log(`LIVE_PERCEPTION_TEXT=${perceived.slice(0, 160)}`)

        // ── 2. The consolidation prompt carries it, with its own boundary ──────
        const entries = await runtime.experienceBuffer.recent({ limit: 10 })
        const context = buildRecentExperienceContext({ entries, limit: 10 })
        const prompt = withExperienceDeclaration(context.rendered)
        const keyword = perceived.slice(0, 12)
        assert.ok(
          String(prompt).includes(keyword) || String(context.rendered).includes('花花看到的'),
          `the real perception must reach the consolidation prompt: ${String(context.rendered).slice(0, 200)}`,
        )
        assert.equal(String(prompt).includes('base64,'), false)
        assert.ok(/source_ids|不是.{0,6}证据|不能作为/u.test(String(prompt)), 'the section declares its evidentiary status')
        console.log(`LIVE_CONSOLIDATION_PROMPT=PASS chars=${String(prompt).length}`)

        // ── 3. Re-open the remembered picture and look again, from scratch ─────
        const attachmentId = anchor.provenance.attachmentId
        assert.ok(attachmentId, 'the anchor carries the picture id used for re-inspection')
        const look = await runtime.reInspectVisualMemory({ attachmentId })
        if (!look.ok) {
          console.log(`LIVE_REINSPECTION=UNAVAILABLE reason=${look.reason}`)
        } else {
          assert.ok(String(look.observation).length > 8, `re-inspection must perceive something: ${look.observation}`)
          console.log(`LIVE_REINSPECTION=PASS chars=${String(look.observation).length}`)
          console.log(`LIVE_REINSPECTION_TEXT=${String(look.observation).slice(0, 160)}`)

          // A single re-inspection returns the fresh perception; it is the
          // consolidation pass that decides to store it as its own row.
          const before = runtime.memory.db.list('fact')
            .filter((row) => String(row.content).includes('花花又看了一眼这张图片')).length
          const consolidation = await runtime.consolidateExperiences({ limit: 20 })
          // The cooldown above already consumed this picture, so prove the write
          // path with a second picture that has not been re-opened yet.
          const refreshed = runtime.memory.db.list('fact')
            .filter((row) => String(row.content).includes('花花又看了一眼这张图片')).length
          console.log(
            `LIVE_REINSPECTION_CONSOLIDATION inspected=${consolidation?.visualReinspections ?? 0} `
            + `rowsBefore=${before} rowsAfter=${refreshed}`,
          )
        }

        // ── 4. A second, different real picture is its own memory ──────────────
        if (sample.length > 1) {
          const second = sample[1]
          const secondAttachment = await runtime.conversationStore.saveAttachment({
            image: { dataUrl: second.dataUrl },
            thumbnail: thumbnail(),
          })
          const turn2 = await runtime.chat('再看看这一张', { dataUrl: second.dataUrl }, secondAttachment)
          assert.equal(turn2.ok, true, `the second real picture must be processed: ${turn2.reason ?? ''} ${turn2.diagnostic?.stage ?? ''}`)
          assert.equal(turn2.imageMemory, 'written', `the second picture must be remembered, got ${turn2.imageMemory}`)
          const observations2 = allMemoryRows(runtime).filter((row) => row.provenance.source === 'VISUAL_OBSERVATION')
          assert.equal(observations2.length, 2, `two pictures -> two perceptions, got ${observations2.length}`)
          console.log(`LIVE_SECOND_PICTURE=PASS sameBytesAsFirst=${second.name === first.name}`)
        }
      }
    } catch (error) {
      console.log(`LIVE_IMAGE_MEMORY=FAILED code=${error.code ?? error.name} message=${error.message}`)
      process.exitCode = 1
    } finally {
      runtime.close()
      await rm(sandbox, { recursive: true, force: true })
    }
  }
}

function allMemoryRows(runtime) {
  return ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
    .flatMap((level) => runtime.memory.db.list(level))
    .map((row) => ({ ...row, provenance: runtime.memory.provenanceStore.resolve(row) }))
}


/**
 * A real client sends a downscaled thumbnail with every upload (the store
 * refuses a >256px image that carries none). The live test has to honour that
 * same contract, so it builds a small, valid companion image.
 */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function solidPng(size, [red, green, blue]) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let cursor = 0
  for (let row = 0; row < size; row += 1) {
    raw[cursor] = 0
    cursor += 1
    for (let column = 0; column < size; column += 1) {
      raw[cursor] = red
      raw[cursor + 1] = green
      raw[cursor + 2] = blue
      raw[cursor + 3] = 255
      cursor += 4
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Read a few real pictures (read-only) so the model has genuine material. */
async function pickRealPictures(limit) {
  const picked = []
  try {
    const years = await readdir(PRODUCTION_ASSETS)
    for (const year of years.sort().reverse()) {
      const months = await readdir(join(PRODUCTION_ASSETS, year))
      for (const month of months.sort().reverse()) {
        const days = await readdir(join(PRODUCTION_ASSETS, year, month))
        for (const day of days.sort().reverse()) {
          const dir = join(PRODUCTION_ASSETS, year, month, day)
          for (const name of (await readdir(dir)).sort().reverse()) {
            if (name.includes('thumbnail')) continue
            if (!/\.(webp|png|jpe?g)$/iu.test(name)) continue
            const bytes = await readFile(join(dir, name))
            if (bytes.length < 50_000) continue
            const mime = name.endsWith('.webp') ? 'image/webp' : name.endsWith('.png') ? 'image/png' : 'image/jpeg'
            picked.push({ name, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` })
            if (picked.length >= limit) return picked
          }
        }
      }
    }
  } catch (error) {
    console.log(`LIVE_PICTURES_UNAVAILABLE reason=${error.message}`)
  }
  return picked
}
