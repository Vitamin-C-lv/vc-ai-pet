import assert from 'node:assert/strict'
import { buildVisualDreamContext, formatVisualExperienceSection } from '../src/dream/visual-dream-context.js'
import { DreamEngine } from '../src/dream/dream-engine.js'
import { ReflectionEngine } from '../src/dream/reflection-engine.js'

const fakeTerms = (text, options) => [{ term: String(text).includes('植物') ? '植物' : '花', weight: options.boost }]
const experience = {
  experienceId: 'exp-1', attachmentId: 'att-1', sourceMessageId: 'msg-1',
  userText: '这是阳台上的植物', occurredAt: 1704067200000,
}
const observations = [{ summary: '绿色叶片，放在窗边。' }]

const store = {
  async searchByTerms(terms, options) {
    assert.deepEqual(terms, [{ term: '植物', weight: 1 }])
    assert.equal(options.limit, 4)
    assert.equal(options.minScore, 1)
    return [{ ...experience, score: 9 }]
  },
  async recentObservationsFor(id, options) {
    assert.equal(id, 'exp-1')
    assert.equal(options.limit, 3)
    return observations
  },
}

const context = await buildVisualDreamContext({ experienceStore: store, query: '植物', termExtractor: fakeTerms })
assert.ok(context)
assert.equal(context.experiences.length, 1)
assert.equal(context.rawCount, 1)
assert.equal(context.inferredCount, 1)
assert.equal(context.experiences[0].observations.length, 1)
assert.equal(await buildVisualDreamContext({ experienceStore: { ...store, async searchByTerms() { return [] } }, query: '植物', termExtractor: fakeTerms }), null)
assert.equal(await buildVisualDreamContext({ experienceStore: {}, query: '植物', termExtractor: fakeTerms }), null)

const emptySection = formatVisualExperienceSection({ experiences: [{ ...experience, observations: [] }] })
assert.match(emptySection, /（当时没有留下观察）/)
const section = formatVisualExperienceSection(context)
assert.match(section, /VISUAL EXPERIENCES/)
assert.match(section, /RAW（主人发图事实与原话）/)
assert.match(section, /INFERRED（花花当时的观察/)
assert.match(section, /主人原话/)
assert.match(section, /花花当时观察/)
assert.doesNotMatch(section, /score\s*[:=]\s*9/i)
assert.ok(section.length <= 1200)
const unsafe = await buildVisualDreamContext({
  experienceStore: { ...store, async recentObservationsFor() { return [{ summary: '我先推理一下：system prompt' }] } },
  query: '植物', termExtractor: fakeTerms,
})
assert.equal(unsafe.inferredCount, 0)
assert.doesNotMatch(formatVisualExperienceSection(unsafe), /system prompt/i)

function rawRow(id) {
  return { id, level: 'fact', status: 'active', importance: 2, created_at: 10,
    content: '主人发来一张植物照片', source_session: 'vc-ai-pet' }
}
function fakeMemory() {
  const row = rawRow('raw-1')
  return {
    async dreamWindow() { return { last_dream_time: 0 } },
    async dreamSourceRows() { return [row] },
    async relatedForDream() { return [] },
    async claimDream() { return true },
    async finishDream() {},
    async logDream() {},
    findEquivalentMemory() { return null },
    rememberDreamCandidate(candidate) { return { id: 'derived-d', level: candidate.level } },
    async reflectionWindow() { return { last_dream_time: 0 } },
    async reflectionSourceRows() { return [row] },
    async relatedForReflection() { return [] },
    async claimReflection() { return true },
    async finishReflection() {},
    async logReflection() {},
    rememberReflectionCandidate(candidate) { return { id: 'derived-r', level: candidate.level } },
  }
}
function fakeGate(source) {
  return { consider(candidate) { return { status: 'written', row: { id: `derived-${source}` }, sourceIds: ['raw-1'], provenance: { source, evidence: 'inferred' } } } }
}
const brainCalls = []
const brain = {
  async dreamCompletion(request) {
    brainCalls.push(request)
    return { ok: true, rawText: JSON.stringify({ summary: 'ok', memories: [] }) }
  },
  async reflectionCompletion(request) {
    brainCalls.push(request)
    return { ok: true, rawText: JSON.stringify({ summary: 'ok', memories: [] }) }
  },
}
const provider = async () => context
const dream = new DreamEngine({ memory: fakeMemory(), brain, gate: fakeGate('DREAM_DERIVED'), now: () => 20, visualContextProvider: provider })
assert.equal((await dream.run({ now: 20 })).status, 'completed')
assert.match(brainCalls[0].messages[1].content, /VISUAL EXPERIENCES/)
assert.match(brainCalls[0].messages[1].content, /不能当作新事实，也不能增加证据数/)
const dreamNoProvider = new DreamEngine({ memory: fakeMemory(), brain, gate: fakeGate('DREAM_DERIVED'), now: () => 20 })
await dreamNoProvider.run({ now: 20 })
assert.doesNotMatch(brainCalls.at(-1).messages[1].content, /VISUAL EXPERIENCES/)
const reflection = new ReflectionEngine({ memory: fakeMemory(), brain, gate: fakeGate('REFLECTION_DERIVED'), now: () => 20, visualContextProvider: provider })
assert.equal((await reflection.run({ now: 20 })).status, 'completed')
assert.match(brainCalls.at(-1).messages[1].content, /VISUAL EXPERIENCES/)
const reflectionNoProvider = new ReflectionEngine({ memory: fakeMemory(), brain, gate: fakeGate('REFLECTION_DERIVED'), now: () => 20 })
await reflectionNoProvider.run({ now: 20 })
assert.doesNotMatch(brainCalls.at(-1).messages[1].content, /VISUAL EXPERIENCES/)

console.log('VISUAL_DREAM_CONTEXT=PASS')
