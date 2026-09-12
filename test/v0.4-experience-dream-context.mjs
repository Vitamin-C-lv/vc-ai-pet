import assert from 'node:assert/strict'

import {
  EXPERIENCE_DREAM_CONTEXT_DECLARATION,
  buildRecentExperienceContext,
  formatExperienceEntry,
  formatExperienceSection,
  withExperienceDeclaration,
} from '../src/experience/experience-dream-context.js'

/**
 * Dream / Reflection input from the Experience Buffer.
 *
 * Two properties matter and nothing else: recent life must actually reach Dream,
 * and it must arrive labelled as *recent experience* rather than as verified
 * long-term evidence. If the declaration is dropped, a one-off event can be
 * written up as permanent truth — the same class of bug as the visual
 * INFERRED/raw confusion the project already fixed once.
 */

const entries = [
  { id: 1, createdAt: 1_700_000_000_000, sourceType: 'owner_chat', content: '主人说黑莓今天睡沙发', importanceScore: 0.4 },
  { id: 2, createdAt: 1_700_000_060_000, sourceType: 'repeated_behavior', content: '主人说黑莓又睡沙发', importanceScore: 0.7 },
  { id: 3, createdAt: 1_700_000_120_000, sourceType: 'emotion_event', content: '主人今天有点难过', importanceScore: 0.9 },
]

// --- empty input never produces a dangling section ---------------------------

assert.equal(formatExperienceSection(null), '', 'no context means no section')
assert.equal(formatExperienceSection({ entries: [] }), '', 'an empty buffer means no section')
assert.equal(formatExperienceSection({ entries: null }), '', 'a null entry list means no section')
assert.equal(withExperienceDeclaration(''), '', 'an empty section must not emit the declaration alone')

// --- the section carries the real experiences --------------------------------

{
  const section = formatExperienceSection({ entries })
  assert.ok(section.includes('RECENT EXPERIENCES'), 'the section must be labelled')
  for (const entry of entries) {
    assert.ok(section.includes(entry.content), `missing experience: ${entry.content}`)
  }
}

// --- the declaration must accompany the section ------------------------------

{
  const composed = withExperienceDeclaration(formatExperienceSection({ entries }))
  assert.ok(composed.includes(EXPERIENCE_DREAM_CONTEXT_DECLARATION), 'the declaration must be present')
  assert.ok(
    /不是长期记忆证据/.test(composed),
    'the declaration must say these are not long-term memory evidence',
  )
  assert.ok(
    /source_ids/.test(composed),
    'the declaration must forbid using experiences as source_ids',
  )
}

// --- ordering and limits are deterministic -----------------------------------

{
  const context = buildRecentExperienceContext({ entries, limit: 2 })
  assert.equal(context.count, 2, 'the limit must be honoured')
  assert.deepEqual(
    context.entries.map((entry) => entry.id),
    [1, 2],
    'entries must keep buffer order',
  )
  assert.ok(context.rendered.includes('主人说黑莓今天睡沙发'))
  assert.ok(!context.rendered.includes('主人今天有点难过'), 'entries past the limit must be excluded')
}

{
  const context = buildRecentExperienceContext({ entries: [], limit: 5 })
  assert.equal(context.count, 0)
  assert.equal(context.rendered, '')
}

// --- malformed entries degrade instead of throwing ---------------------------

{
  assert.doesNotThrow(() => formatExperienceEntry(null))
  assert.doesNotThrow(() => formatExperienceEntry({}))
  assert.doesNotThrow(() => formatExperienceSection({ entries: [null, undefined, {}] }))
  const context = buildRecentExperienceContext({ entries: null, limit: 3 })
  assert.equal(context.count, 0)
  const weird = formatExperienceEntry({ createdAt: 'not-a-time', sourceType: 'unknown_type', content: '' })
  assert.ok(weird.includes('unknown'), 'an unparseable timestamp must be reported, not printed as NaN')
  assert.ok(weird.includes('(empty experience)'), 'empty content must be obvious')
}

// --- source labels stay human readable for the prompt ------------------------

{
  const line = formatExperienceEntry(entries[1])
  assert.ok(line.includes('repeated_behavior'), 'the machine source type must be visible')
  assert.ok(line.includes('反复出现'), 'the human label must be visible')
  assert.ok(line.includes('0.70'), 'the importance score must be visible')
}

console.log('VC_AI_PET_V0_4_EXPERIENCE_DREAM_CONTEXT=PASS')
