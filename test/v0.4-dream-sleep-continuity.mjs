import assert from 'node:assert/strict'

import {
  DreamScheduler,
  DEEP_DREAM_ASLEEP_STATES,
  DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS,
  DEEP_DREAM_DAYTIME_SLEEP_CONTINUITY_MS,
} from '../src/dream/dream-scheduler.js'
import { createInitialState, advanceState } from '../src/core/pet-state-engine.js'

/**
 * Deep Dream sleep continuity.
 *
 * Root cause this test pins down (measured 2026-09-13 on the production pet):
 * the gate used to require *uninterrupted time in the literal `sleep` state*, but
 * the real state machine enters `sleep` above sleepiness 0.86 and drains
 * sleepiness 4.2x faster than idling adds it, so the pet flickered
 * `sleepy -> sleep -> sleepy` on a roughly 3.4:1 tick ratio. Fragmented runs of
 * a few ticks can never reach any continuity threshold, so Deep Dream starved for
 * six days while Reflection (no sleep gate) kept running.
 *
 * The fix: one dozy stretch counts as one sleep episode, and only a genuinely
 * awake state ends it. These cases cover both halves of that sentence - a
 * fragmented night must dream, and a real wake-up must still defer.
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/** Local 02:00 — inside the night window (22:30-08:00). */
function nightNow() {
  const value = new Date('2026-09-13T12:00:00+08:00')
  value.setHours(2, 0, 0, 0)
  return value.getTime()
}

/** Local 14:00 — daytime, where the longer threshold applies. */
function dayNow() {
  const value = new Date('2026-09-13T12:00:00+08:00')
  value.setHours(14, 0, 0, 0)
  return value.getTime()
}

function fixture({ initialNow, timeZone = 'Asia/Shanghai' } = {}) {
  let now = initialNow
  const runCalls = []
  let eligibilityCalls = 0
  const scheduler = new DreamScheduler({
    engine: {
      run: async (options) => {
        runCalls.push(options)
        return { status: 'completed' }
      },
    },
    deepDreamEligibility: () => {
      eligibilityCalls += 1
      return { eligible: true, reason: 'raw-source-ready' }
    },
    deepDreamSuccessCooldownMs: 30 * MINUTE,
    now: () => now,
    timeZone,
  })
  return {
    scheduler,
    runCalls,
    get now() { return now },
    set now(value) { now = value },
    get eligibilityCalls() { return eligibilityCalls },
  }
}

/**
 * Drive one tick per state in the list, advancing the clock by `stepMs`.
 *
 * The scheduler deliberately keeps its own RAM episode start across ticks (that
 * is how a real tick loop feeds it), so this helper must NOT reset it between
 * steps - doing so would erase the very continuity being tested.
 */
async function drive(scheduler, states, { from, stepMs }) {
  let timestamp = from
  let last = null
  let firstStarted = null
  for (const current of states) {
    last = await scheduler.maybeRunDeepDream({ state: { current }, now: timestamp })
    if (!firstStarted && last?.schedulerStatus === 'started') firstStarted = { at: timestamp, current, result: last }
    timestamp += stepMs
  }
  return { last, firstStarted, endedAt: timestamp }
}

// ── 1. A fragmented dozy night must still dream ─────────────────────────────
{
  const start = nightNow()
  const f = fixture({ initialNow: start })
  const states = []
  // 20 minutes of real sleeping behaviour: mostly sleepy/rest, occasionally the
  // literal sleep state, exactly as the measured state machine oscillates.
  for (let index = 0; index < 120; index += 1) {
    states.push(index % 7 === 0 ? 'sleep' : index % 3 === 0 ? 'rest' : 'sleepy')
  }
  const { firstStarted, last } = await drive(f.scheduler, states, { from: start, stepMs: 10 * 1000 })
  assert.ok(
    firstStarted,
    `a fragmented dozy stretch must dream, never started (last=${JSON.stringify(last)})`,
  )
  assert.ok(
    firstStarted.at - start >= DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS,
    `it must wait for the continuity threshold, started after ${(firstStarted.at - start) / 1000}s`,
  )
  assert.equal(f.runCalls.length, 1, 'exactly one dream run (the cooldown bounds the rest)')
  assert.ok(
    !states.includes('idle') && !states.includes('walk'),
    'the fixture must not contain an awake state',
  )
  console.log('DREAM_CONTINUITY_FRAGMENTED_NIGHT=PASS')
}

// ── 2. `rest`/`sleepy` alone (never the literal sleep state) also count ─────
{
  const start = nightNow()
  const f = fixture({ initialNow: start })
  const states = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 'sleepy' : 'rest'))
  const { firstStarted } = await drive(f.scheduler, states, { from: start, stepMs: 10 * 1000 })
  assert.ok(firstStarted, 'dozing (sleepy/rest) counts as asleep')
  assert.equal(f.runCalls.length, 1)
  console.log('DREAM_CONTINUITY_DOZING_ONLY=PASS')
}

// ── 3. A genuine awake state resets the episode ─────────────────────────────
for (const awake of ['idle', 'walk', 'curious', 'happy']) {
  const start = nightNow()
  const f = fixture({ initialNow: start })
  // Doze for 6 minutes (below the 8-minute threshold, so nothing may run yet),
  // then wake up, then doze again.
  await drive(f.scheduler, ['sleep', 'sleepy', 'rest'], { from: start, stepMs: 2 * MINUTE })
  const beforeWake = await f.scheduler.maybeRunDeepDream({
    state: { current: 'sleepy' },
    now: start + 6 * MINUTE,
  })
  assert.equal(beforeWake.reason, 'sleep-continuity-not-met', 'six minutes is not enough yet')
  assert.equal(f.runCalls.length, 0, 'nothing may have run before the threshold')

  const afterWake = await f.scheduler.maybeRunDeepDream({
    state: { current: awake },
    now: start + 6 * MINUTE + 10 * 1000,
  })
  assert.equal(afterWake.status, 'skipped', `${awake}: an awake state must not dream`)
  assert.equal(afterWake.reason, 'not-asleep', `${awake}: reason=${afterWake.reason}`)

  // The episode restarts the moment the pet dozes again: the new start is this
  // tick, so even though the wall clock is far past the threshold measured from
  // the first doze, the episode has only just begun.
  const restartAt = start + 10 * MINUTE
  const restarted = await f.scheduler.maybeRunDeepDream({
    state: { current: 'sleepy' },
    now: restartAt,
  })
  assert.equal(restarted.status, 'skipped', `${awake}: the episode must restart after waking`)
  assert.equal(restarted.reason, 'sleep-continuity-not-met', `${awake}: reason=${restarted.reason}`)
  // The new episode is measured from the awakening itself (or, at the latest,
  // from this first asleep tick) - never from the old episode's start.
  assert.ok(
    restarted.sleepContinuitySince >= start + 6 * MINUTE + 10 * 1000
      && restarted.sleepContinuitySince <= restartAt,
    `${awake}: episode restarted at the awakening, got ${restarted.sleepContinuitySince}`,
  )
  assert.equal(f.runCalls.length, 0, `${awake}: nothing may have run yet`)

  // Only a full threshold measured from the *new* episode may dream: the old
  // episode's start must not carry over into this one.
  const episodeStart = restarted.sleepContinuitySince
  const oneMsEarly = episodeStart + DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS - 1
  const stillTooSoon = await f.scheduler.maybeRunDeepDream({
    state: { current: 'rest' },
    now: oneMsEarly,
  })
  assert.equal(stillTooSoon.reason, 'sleep-continuity-not-met', `${awake}: one millisecond early`)
  assert.equal(stillTooSoon.sleepContinuitySince, episodeStart, `${awake}: the start must not advance`)
  assert.ok(
    oneMsEarly < start + 6 * MINUTE + 10 * 1000 + DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS,
    `${awake}: the new episode must outlast the old one's clock`,
  )
  const finallyDue = await f.scheduler.maybeRunDeepDream({
    state: { current: 'rest' },
    now: episodeStart + DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS,
  })
  assert.equal(finallyDue.schedulerStatus, 'started', `${awake}: the new episode must dream once long enough`)
  assert.equal(f.runCalls.length, 1)
  console.log(`DREAM_CONTINUITY_WAKE_RESETS_${awake.toUpperCase()}=PASS`)
}

// ── 4. The continuous-sleep threshold is honoured exactly ───────────────────
{
  const start = nightNow()
  const f = fixture({ initialNow: start })
  const justUnder = await f.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: start - (DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS - 1) },
    now: start,
  })
  assert.equal(justUnder.reason, 'sleep-continuity-not-met')
  const atThreshold = await f.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: start - DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS },
    now: start,
  })
  assert.equal(atThreshold.schedulerStatus, 'started', `at-threshold must pass: ${JSON.stringify(atThreshold)}`)
  assert.equal(f.runCalls.length, 1)
  console.log('DREAM_CONTINUITY_THRESHOLD_EXACT=PASS')
}

// ── 5. Daytime needs the longer dozy stretch ────────────────────────────────
{
  const start = dayNow()
  const f = fixture({ initialNow: start })
  const justUnder = await f.scheduler.maybeRunDeepDream({
    state: { current: 'sleepy', sleepSince: start - (DEEP_DREAM_DAYTIME_SLEEP_CONTINUITY_MS - 1) },
    now: start,
  })
  assert.equal(justUnder.reason, 'daytime-sleep-continuity-not-met')
  assert.equal(justUnder.requiredMs, DEEP_DREAM_DAYTIME_SLEEP_CONTINUITY_MS)
  assert.ok(
    DEEP_DREAM_DAYTIME_SLEEP_CONTINUITY_MS > DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS,
    'the daytime threshold must stay the stricter one',
  )
  const atThreshold = await f.scheduler.maybeRunDeepDream({
    state: { current: 'sleepy', sleepSince: start - DEEP_DREAM_DAYTIME_SLEEP_CONTINUITY_MS },
    now: start,
  })
  assert.equal(atThreshold.schedulerStatus, 'started', `daytime nap at threshold: ${JSON.stringify(atThreshold)}`)
  console.log('DREAM_CONTINUITY_DAYTIME_THRESHOLD=PASS')
}

// ── 6. Injected thresholds are honoured and production defaults are sane ────
{
  const start = nightNow()
  let now = start
  const scheduler = new DreamScheduler({
    engine: { run: async () => ({ status: 'completed' }) },
    deepDreamEligibility: () => ({ eligible: true }),
    now: () => now,
    timeZone: 'Asia/Shanghai',
    minSleepContinuityMs: 30 * 1000,
  })
  // The runtime publishes the episode start; with a 30s threshold, 20s in is too
  // soon and 30s in is due. (The injected value must win over the default 8min.)
  now = start
  const tooSoon = await scheduler.maybeRunDeepDream({
    state: { current: 'rest', sleepSince: start - 20 * 1000 },
    now,
  })
  assert.equal(tooSoon.reason, 'sleep-continuity-not-met', 'the injected threshold must be used')
  assert.equal(tooSoon.requiredMs, 30 * 1000)
  const ok = await scheduler.maybeRunDeepDream({
    state: { current: 'rest', sleepSince: start - 30 * 1000 },
    now,
  })
  assert.equal(ok.schedulerStatus, 'started', `injected threshold must fire: ${JSON.stringify(ok)}`)
  assert.equal(DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS, 8 * MINUTE)
  assert.equal(DEEP_DREAM_DAYTIME_SLEEP_CONTINUITY_MS, 20 * MINUTE)
  assert.deepEqual([...DEEP_DREAM_ASLEEP_STATES], ['sleep', 'sleepy', 'rest'])
  console.log('DREAM_CONTINUITY_CONFIGURABLE=PASS')
}

// ── 7. Forced runs still bypass every sleep gate ────────────────────────────
{
  const start = nightNow()
  const f = fixture({ initialNow: start })
  const forced = await f.scheduler.runDeepDreamNow({ state: { current: 'idle' }, now: start })
  assert.equal(forced.schedulerStatus, 'started', 'a manual dream ignores the sleep gate')
  assert.equal(f.runCalls.length, 1)
  console.log('DREAM_CONTINUITY_FORCED_BYPASS=PASS')
}

// ── 8. Cooldown still bounds the new, easier gate ───────────────────────────
{
  const start = nightNow()
  const f = fixture({ initialNow: start })
  const first = await f.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: start - 10 * MINUTE },
    now: start,
  })
  assert.equal(first.schedulerStatus, 'started')
  const second = await f.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: start - 40 * MINUTE },
    now: start + 5 * MINUTE,
  })
  assert.equal(second.status, 'skipped')
  assert.equal(second.reason, 'deep-dream-cooldown', 'the 30-minute cooldown must hold')
  assert.equal(f.runCalls.length, 1)
  console.log('DREAM_CONTINUITY_COOLDOWN_HOLDS=PASS')
}

// ── 9. Against the real state engine, a night does produce sleep episodes ───
{
  // The engine is the other half of the story: prove a real, tick-by-tick pet
  // spends long enough asleep for the continuity gate to ever be satisfied.
  // Measured over 36h the split is: sleepy 65.6%, sleep 19.3%, rest 0.1%,
  // walk/idle the remainder - i.e. dozing dominates, which is exactly what the
  // gate now counts.
  let state = createInitialState(Date.now())
  const counts = new Map()
  let longestAsleepRun = 0
  let currentRun = 0
  for (let index = 0; index < 2 * 60 * 60 * 10; index += 1) { // 2 hours at 10s ticks
    state = advanceState(state, state.lastUpdatedAt + 10 * 1000)
    counts.set(state.current, (counts.get(state.current) ?? 0) + 1)
    if (DEEP_DREAM_ASLEEP_STATES.includes(state.current)) {
      currentRun += 1
      longestAsleepRun = Math.max(longestAsleepRun, currentRun)
    } else {
      currentRun = 0
    }
  }
  const asleepTicks = [...counts.entries()]
    .filter(([name]) => DEEP_DREAM_ASLEEP_STATES.includes(name))
    .reduce((total, [, value]) => total + value, 0)
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
  assert.ok(
    asleepTicks / total > 0.5,
    `the pet should be asleep most of an idle stretch, got ${(asleepTicks / total * 100).toFixed(1)}%`,
  )
  assert.ok(
    longestAsleepRun * 10 * 1000 >= DEEP_DREAM_MIN_SLEEP_CONTINUITY_MS,
    `a real stretch must clear the threshold, longest run was ${longestAsleepRun * 10}s`,
  )
  console.log(`DREAM_CONTINUITY_REAL_ENGINE=PASS asleepRatio=${(asleepTicks / total * 100).toFixed(1)}% longestRun=${longestAsleepRun * 10}s`)
}

console.log('VC_AI_PET_V0_4_DREAM_SLEEP_CONTINUITY=PASS')
