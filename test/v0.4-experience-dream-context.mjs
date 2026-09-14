import assert from 'node:assert/strict'

import {
  EXPERIENCE_DREAM_CONTEXT_DECLARATION,
  buildRecentExperienceContext,
  formatRecentVisualObservations,
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
  {
    id: 4,
    createdAt: 1_700_000_180_000,
    sourceType: 'pet_vision',
    importanceScore: 0.6,
    content: '主人这一轮发送了图片',
    visionSummary: '主人这一轮发送了图片',
    visionId: 'V0',
    attachmentId: 'attachment-cat-window',
    visualObservation: ['窗边有一只橘猫，尾巴轻轻卷着'],
    visualFocus: '猫的姿态',
  },
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
    if (entry.visualObservation) {
      assert.ok(section.includes(entry.visualObservation[0]), 'missing real visual observation')
    } else {
      assert.ok(section.includes(entry.content), `missing experience: ${entry.content}`)
    }
  }
}

// Visual observations are Dream background only: visible, bounded, and never
// part of the memory evidence graph.
{
  const now = 1_700_000_200_000
  const visualSection = formatRecentVisualObservations([
    {
      id: 7,
      createdAt: now - 60_000,
      sourceType: 'pet_vision',
      attachmentId: 'attachment-cat-window',
      visualObservation: ['窗边有一只橘猫，尾巴轻轻卷着'],
    },
    {
      id: 8,
      createdAt: now - 48 * 60 * 60 * 1000,
      sourceType: 'pet_vision',
      visualObservation: ['两天前的观察不应出现'],
    },
  ], { now, limit: 3 })
  assert.match(visualSection, /RECENT VISUAL OBSERVATIONS/)
  assert.match(visualSection, /\[INFERRED\]/)
  assert.match(visualSection, /窗边有一只橘猫/)
  assert.doesNotMatch(visualSection, /两天前的观察不应出现/)
  assert.match(visualSection, /不能作为 source_ids/)
  assert.match(visualSection, /不能增加 evidenceCount/)
  assert.match(visualSection, /不能提高 confidence/)
  console.log('DREAM_SEES_VISUAL_OBSERVATION=YES')
  console.log('VISUAL_OBSERVATION_IN_SOURCE_IDS=NO')
  console.log('VISUAL_OBSERVATION_COUNTS_AS_RAW_ROOT=NO')
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
  assert.ok(/感知记录/.test(composed), 'the declaration must distinguish visual perception records')
  assert.ok(/attachmentId/.test(composed), 'the declaration must explain how to re-view an attachment')
  assert.ok(composed.includes('窗边有一只橘猫，尾巴轻轻卷着'), 'real visual observation must be rendered')
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
  const oldVision = formatExperienceEntry({
    createdAt: 1_700_000_000_000,
    sourceType: 'pet_vision',
    content: '主人这一轮发送了图片',
    visionSummary: '主人这一轮发送了图片',
  })
  assert.ok(oldVision.includes('暂无真实观察记录'), 'old visual rows must not pretend the template is an observation')
  assert.ok(oldVision.includes('历史图片摘要（非观察）'), 'old visual summary must stay clearly labelled')
}

// --- source labels stay human readable for the prompt ------------------------

{
  const line = formatExperienceEntry(entries[1])
  assert.ok(line.includes('repeated_behavior'), 'the machine source type must be visible')
  assert.ok(line.includes('反复出现'), 'the human label must be visible')
  assert.ok(line.includes('0.70'), 'the importance score must be visible')
}

console.log('VC_AI_PET_V0_4_EXPERIENCE_DREAM_CONTEXT=PASS')
