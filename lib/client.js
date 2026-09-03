window.__ModuleLoader__.load({
  id: "vc-ai-pet",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v))
    const DEFAULT_STATE=Object.freeze({schemaVersion:1,bornAt:null,lastUpdatedAt:null,current:'idle',mood:.65,energy:.82,boredom:.20,curiosity:.55,sleepiness:.08,attachment:.50,interactionsToday:0,lifetimeInteractions:0,lastInteractionAt:null})
    function createInitialState(now=Date.now()){return {...DEFAULT_STATE,bornAt:now,lastUpdatedAt:now}}
    function advanceState(input,now=Date.now()){const s={...input},prev=s.lastUpdatedAt??now,m=Math.max(0,Math.min((now-prev)/60000,240));s.energy=clamp(s.energy-m*.0014);s.boredom=clamp(s.boredom+m*.0021);s.curiosity=clamp(s.curiosity+m*.0007);s.sleepiness=clamp(s.sleepiness+m*.0019);s.mood=clamp(s.mood-m*.00025);s.lastUpdatedAt=now;if(s.sleepiness>.86||s.energy<.15)s.current='sleep';else if(s.sleepiness>.70)s.current='sleepy';else if(s.boredom>.73&&s.energy>.34)s.current='walk';else if(s.energy<.32)s.current='rest';else if(s.curiosity>.72)s.current='curious';else s.current='idle';if(s.current==='sleep'){s.energy=clamp(s.energy+m*.006);s.sleepiness=clamp(s.sleepiness-m*.008);s.boredom=clamp(s.boredom-m*.0005)}if(s.current==='walk'){s.energy=clamp(s.energy-m*.002);s.boredom=clamp(s.boredom-m*.006)}return s}
    function interact(input,kind='pet',now=Date.now()){const s=advanceState(input,now);s.lastInteractionAt=now;s.interactionsToday=(s.interactionsToday??0)+1;s.lifetimeInteractions=(s.lifetimeInteractions??0)+1;if(kind==='wake'){s.current='curious';s.sleepiness=clamp(s.sleepiness-.30);s.energy=clamp(s.energy+.08);s.mood=clamp(s.mood+.05)}else if(kind==='play'){s.current='happy';s.boredom=clamp(s.boredom-.24);s.energy=clamp(s.energy-.05);s.attachment=clamp(s.attachment+.012);s.mood=clamp(s.mood+.10)}else{s.current=s.current==='sleep'?'curious':'happy';s.boredom=clamp(s.boredom-.10);s.attachment=clamp(s.attachment+.006);s.mood=clamp(s.mood+.06)}return s}
    function chooseVisual(state,r=Math.random()){switch(state.current){case'walk':return'walk';case'sleep':return r<.5?'sleep-curled':'sleep-side';case'sleepy':return'sleepy';case'rest':return r<.5?'rest-awake':'rest-curled';case'curious':return'curious';case'happy':return r<.7?'playbow':'jump';default:if(r<.12)return'blink';if(r<.24)return'idle-3q';return'idle'}}

    const SPRITES=Object.freeze({idle:'idle-front.png','idle-3q':'idle-3q.png',blink:'blink-happy.png',curious:'curious.png',playbow:'playbow.png',jump:'jump.png',sit:'sit.png','rest-awake':'rest-awake.png','rest-curled':'rest-curled.png',sleepy:'sleepy-sit.png','sleep-curled':'sleep-curled.png','sleep-side':'sleep-side.png',stretch:'stretch.png',surprised:'surprised.png',beg:'beg.png',bark:'bark.png'})

    const PET_VISUAL_STATES = Object.freeze([
      'idle',
      'thinking',
      'happy',
      'excited',
      'relaxed',
      'waiting',
      'curious',
      'confused',
      'sleep',
      'dreaming',
      'walk',
    ])

    const DEFAULT_PET_VISUAL_CONFIG = Object.freeze({
      nightStartHour: 23,
      nightEndHour: 6,
      inactivitySleepMinutes: 30,
      happyDurationMs: 2_500,
      excitedDurationMs: 1_700,
      relaxedDurationMs: 3_200,
      confusedDurationMs: 2_000,
      thinkingPulseMs: 700,
      walkFrameMs: 150,
      longPressMs: 700,
      interactionBurstWindowMs: 30_000,
      waitingAfterInteractionMinutes: 30,
      idleActionMinMs: 20_000,
      idleActionMaxMs: 60_000,
      idleActionDurationMs: 1_800,
      zzzEnabled: true,
      ambientMoveEnabled: true,
    })

    function boundedNumber(value, fallback, minimum, maximum) {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
        ? parsed
        : fallback
    }

    function boolean(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    function activeFeedbackKind(feedback, now) {
      if (!feedback || typeof feedback !== 'object') return null
      const until = Number(feedback.until)
      if (!Number.isFinite(until) || until <= now) return null
      return ['excited', 'happy', 'relaxed', 'curious', 'confused'].includes(feedback.kind)
        ? feedback.kind
        : null
    }

    function recentInteraction(state, now, windowMs) {
      if (state?.lastInteractionAt === null || state?.lastInteractionAt === undefined || state?.lastInteractionAt === '') return false
      const lastInteractionAt = Number(state?.lastInteractionAt)
      if (!Number.isFinite(lastInteractionAt)) return false
      return now >= lastInteractionAt && now - lastInteractionAt <= windowMs
    }

    /**
     * Normalizes the small, UI-only configuration surface shared by the host and
     * browser overlay. It deliberately contains no brain, memory, or Dream gate
     * settings.
     */
    function normalizePetVisualConfig(input = {}) {
      const source = input && typeof input === 'object' ? input : {}

      return {
        nightStartHour: boundedNumber(source.nightStartHour, DEFAULT_PET_VISUAL_CONFIG.nightStartHour, 0, 23),
        nightEndHour: boundedNumber(source.nightEndHour, DEFAULT_PET_VISUAL_CONFIG.nightEndHour, 0, 23),
        inactivitySleepMinutes: boundedNumber(source.inactivitySleepMinutes, DEFAULT_PET_VISUAL_CONFIG.inactivitySleepMinutes, 1, 24 * 60),
        happyDurationMs: boundedNumber(source.happyDurationMs, DEFAULT_PET_VISUAL_CONFIG.happyDurationMs, 250, 30_000),
        excitedDurationMs: boundedNumber(source.excitedDurationMs, DEFAULT_PET_VISUAL_CONFIG.excitedDurationMs, 250, 30_000),
        relaxedDurationMs: boundedNumber(source.relaxedDurationMs, DEFAULT_PET_VISUAL_CONFIG.relaxedDurationMs, 250, 30_000),
        confusedDurationMs: boundedNumber(source.confusedDurationMs, DEFAULT_PET_VISUAL_CONFIG.confusedDurationMs, 250, 30_000),
        thinkingPulseMs: boundedNumber(source.thinkingPulseMs, DEFAULT_PET_VISUAL_CONFIG.thinkingPulseMs, 120, 10_000),
        walkFrameMs: boundedNumber(source.walkFrameMs, DEFAULT_PET_VISUAL_CONFIG.walkFrameMs, 80, 5_000),
        longPressMs: boundedNumber(source.longPressMs, DEFAULT_PET_VISUAL_CONFIG.longPressMs, 350, 2_000),
        interactionBurstWindowMs: boundedNumber(source.interactionBurstWindowMs, DEFAULT_PET_VISUAL_CONFIG.interactionBurstWindowMs, 5_000, 120_000),
        waitingAfterInteractionMinutes: boundedNumber(source.waitingAfterInteractionMinutes, DEFAULT_PET_VISUAL_CONFIG.waitingAfterInteractionMinutes, 1, 24 * 60),
        idleActionMinMs: boundedNumber(source.idleActionMinMs, DEFAULT_PET_VISUAL_CONFIG.idleActionMinMs, 5_000, 10 * 60_000),
        idleActionMaxMs: boundedNumber(source.idleActionMaxMs, DEFAULT_PET_VISUAL_CONFIG.idleActionMaxMs, 5_000, 10 * 60_000),
        idleActionDurationMs: boundedNumber(source.idleActionDurationMs, DEFAULT_PET_VISUAL_CONFIG.idleActionDurationMs, 250, 10_000),
        zzzEnabled: boolean(source.zzzEnabled, DEFAULT_PET_VISUAL_CONFIG.zzzEnabled),
        ambientMoveEnabled: boolean(source.ambientMoveEnabled, DEFAULT_PET_VISUAL_CONFIG.ambientMoveEnabled),
      }
    }

    /**
     * Central visual-state priority. Environment flags are presentation-only;
     * this function never changes the persistent pet state or any brain input.
     */
    function resolvePetVisualState({
      petState = null,
      environment = {},
      feedback = null,
      emotion = null,
      config = DEFAULT_PET_VISUAL_CONFIG,
      now = Date.now(),
    } = {}) {
      const visualConfig = normalizePetVisualConfig(config)
      const current = typeof petState?.current === 'string' ? petState.current : 'idle'
      const recentInteractionWindow = visualConfig.waitingAfterInteractionMinutes * 60_000
      const hasRecentInteraction = typeof environment.recentInteraction === 'boolean'
        ? environment.recentInteraction
        : recentInteraction(petState, now, recentInteractionWindow)

      if (environment.dreamRunning) return 'dreaming'
      if (environment.chatPending || current === 'thinking') return 'thinking'

      const feedbackKind = activeFeedbackKind(feedback, now)
      if (feedbackKind === 'excited' || emotion?.burstLevel === 'excited' || current === 'excited') return 'excited'
      if (feedbackKind === 'happy') return 'happy'
      // A long press follows the established pet state-machine interaction, which
      // is "happy". Its shared presentation feedback must still visibly win.
      if (feedbackKind === 'relaxed' || current === 'relaxed' || current === 'rest') return 'relaxed'
      if (current === 'happy' && recentInteraction(petState, now, visualConfig.happyDurationMs)) return 'happy'

      // Waiting is intentionally quiet: it is only visible when the chat bubble
      // is closed and the owner interacted recently. It never emits text.
      if (environment.chatOpen === false && hasRecentInteraction) return 'waiting'

      if (feedbackKind === 'confused' || emotion?.burstLevel === 'confused' || current === 'confused') return 'confused'
      if (feedbackKind === 'curious' || emotion?.burstLevel === 'curious' || current === 'curious') return 'curious'

      if (environment.nightTime && environment.longTimeNoInteraction) return 'sleep'
      if (current === 'sleep' || current === 'sleepy') return 'sleep'

      // A visible-but-inactive DSH window is only a weak owner-working hint. Keep
      // the pet quiet instead of letting the existing idle state machine wander.
      if (current === 'walk' && !environment.ownerWorking) return 'walk'

      return 'idle'
    }

    const WEEKDAYS = Object.freeze([
      '星期日',
      '星期一',
      '星期二',
      '星期三',
      '星期四',
      '星期五',
      '星期六',
    ])

    const TIME_CONTEXT_FIELDS = Object.freeze([
      'currentDate',
      'currentTime',
      'weekday',
      'dayPeriod',
      'season',
    ])

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function dateFromInput(value) {
      const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
      if (Number.isNaN(date.getTime())) throw new TypeError('VC_AI_PET_TIME_CONTEXT_DATE_INVALID')
      return date
    }

    function dayPeriodForHour(hour) {
      if (hour < 6) return '凌晨'
      if (hour < 12) return '上午'
      if (hour < 18) return '下午'
      return '晚上'
    }

    function seasonForMonth(month) {
      if (month >= 3 && month <= 5) return '春季'
      if (month >= 6 && month <= 8) return '夏季'
      if (month >= 9 && month <= 11) return '秋季'
      return '冬季'
    }

    /**
     * Read the local system clock once and expose only the current calendar/time
     * context needed by the Pet. The returned snapshot is ephemeral and carries
     * no memory, conversation, Dream, or Historical Recall data.
     */
    function getCurrentTimeContext(now = Date.now()) {
      const date = dateFromInput(now)
      const hour = date.getHours()
      const month = date.getMonth() + 1

      return Object.freeze({
        currentDate: `${date.getFullYear()}-${pad(month)}-${pad(date.getDate())}`,
        currentTime: `${pad(hour)}:${pad(date.getMinutes())}`,
        weekday: WEEKDAYS[date.getDay()],
        dayPeriod: dayPeriodForHour(hour),
        season: seasonForMonth(month),
      })
    }

    // These aliases keep the provider easy to discover without creating separate
    // clock implementations at call sites.
    const createTimeContext = getCurrentTimeContext
    const provideTimeContext = getCurrentTimeContext


    function timestamp(value) {
      if (value === null || value === undefined || value === '') return null
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }

    function defaultVisibility() {
      return globalThis.document?.visibilityState ?? 'visible'
    }

    function isNightTime(now = Date.now(), config = {}) {
      const visualConfig = normalizePetVisualConfig(config)
      const hour = Number(getCurrentTimeContext(now).currentTime.slice(0, 2))
      const { nightStartHour: start, nightEndHour: end } = visualConfig

      if (start === end) return false
      return start > end
        ? hour >= start || hour < end
        : hour >= start && hour < end
    }

    /**
     * Safe, read-only presence labels. The detector deliberately reads only the
     * clock, public pet timestamps, in-memory request flags, and page visibility.
     * It never observes window titles, document contents, clipboard, or files.
     */
    function createPetEnvironment({
      petState = null,
      chatPending = false,
      dreamRunning = false,
      chatOpen = false,
      visibilityState = defaultVisibility(),
      config = {},
      now = Date.now(),
    } = {}) {
      const visualConfig = normalizePetVisualConfig(config)
      const lastInteractionTimestamp = timestamp(petState?.lastInteractionAt)
      const lastInteractionAt = lastInteractionTimestamp
        ?? timestamp(petState?.bornAt)
        ?? now
      const inactiveForMs = Math.max(0, now - lastInteractionAt)
      const longTimeNoInteraction = inactiveForMs >= visualConfig.inactivitySleepMinutes * 60_000
      const nightTime = isNightTime(now, visualConfig)
      const recentInteraction = lastInteractionTimestamp !== null
        && inactiveForMs < visualConfig.waitingAfterInteractionMinutes * 60_000

      return {
        nightTime,
        longTimeNoInteraction,
        chatPending: Boolean(chatPending),
        dreamRunning: Boolean(dreamRunning),
        chatOpen: Boolean(chatOpen),
        recentInteraction,
        ownerWorking: Boolean(!nightTime && longTimeNoInteraction && visibilityState === 'visible'),
      }
    }

    /**
     * Momentary, browser-only emotion telemetry.
     *
     * This module intentionally has no persistence, host bridge, model, memory,
     * or conversation imports. Callers keep the returned object in React state
     * (or another in-memory store) and may discard it at any time.
     */

    const EMOTION_KEYS = Object.freeze([
      'happiness',
      'energy',
      'curiosity',
      'comfort',
      'attachment',
    ])

    const DEFAULT_EMOTION_STATE = Object.freeze({
      happiness: 0.5,
      energy: 0.7,
      curiosity: 0.4,
      comfort: 0.6,
      attachment: 0.5,
    })

    const INTERACTION_BURST_WINDOW_MS = 30_000
    const INTERACTION_BURST_LEVELS = Object.freeze({
      idle: 'idle',
      happy: 'happy',
      excited: 'excited',
      confused: 'confused',
    })

    const IDLE_ACTIONS = Object.freeze([
      Object.freeze({ kind: 'blink', probability: 0.35 }),
      Object.freeze({ kind: 'tail_move', probability: 0.25 }),
      Object.freeze({ kind: 'stretch', probability: 0.15 }),
      Object.freeze({ kind: 'yawn', probability: 0.10 }),
      Object.freeze({ kind: 'look_around', probability: 0.10 }),
      Object.freeze({ kind: 'change_pose', probability: 0.05 }),
    ])

    const INTERACTION_DELTAS = Object.freeze({
      pet: Object.freeze({ happiness: 0.02, comfort: 0.02, attachment: 0.005 }),
      play: Object.freeze({ happiness: 0.05, energy: -0.02, attachment: 0.01 }),
      'long-press': Object.freeze({ comfort: 0.08, happiness: 0.03 }),
      // Chat is a user action, but deliberately carries no numeric emotion delta.
      // The visual response is initiated before the host/model request starts.
      chat: Object.freeze({}),
    })

    const numeric = (value, fallback) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }

    const clampEmotion = (value) => Math.max(0, Math.min(1, numeric(value, 0)))

    function validTimestamp(value) {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
    }

    function compactInteractionTimes(times, now, windowMs) {
      const current = validTimestamp(now) ?? Date.now()
      const window = Math.max(1, numeric(windowMs, INTERACTION_BURST_WINDOW_MS))
      return (Array.isArray(times) ? times : [])
        .map(validTimestamp)
        .filter((time) => time !== null && time <= current && current - time <= window)
    }

    function createEmotionState(initial = {}, now = Date.now(), { windowMs = INTERACTION_BURST_WINDOW_MS } = {}) {
      const source = initial && typeof initial === 'object' ? initial : {}
      const timestamp = validTimestamp(now) ?? Date.now()
      const interactionTimes = compactInteractionTimes(source.interactionTimes, timestamp, windowMs)

      return {
        ...DEFAULT_EMOTION_STATE,
        ...Object.fromEntries(EMOTION_KEYS.map((key) => [key, clampEmotion(source[key] ?? DEFAULT_EMOTION_STATE[key])])),
        interactionTimes,
        burstCount: interactionTimes.length,
        burstLevel: burstLevelForCount(interactionTimes.length),
        lastInteractionAt: validTimestamp(source.lastInteractionAt),
        lastEvent: typeof source.lastEvent === 'string' ? source.lastEvent : null,
        lastEventAt: validTimestamp(source.lastEventAt),
        lastUpdatedAt: validTimestamp(source.lastUpdatedAt) ?? timestamp,
        dreaming: source.dreaming === true,
      }
    }

    function burstLevelForCount(count) {
      const value = Math.max(0, Math.trunc(numeric(count, 0)))
      if (value > 15) return INTERACTION_BURST_LEVELS.confused
      if (value > 5) return INTERACTION_BURST_LEVELS.excited
      if (value > 0) return INTERACTION_BURST_LEVELS.happy
      return INTERACTION_BURST_LEVELS.idle
    }

    function interactionBurstCount(state, now = Date.now(), windowMs = INTERACTION_BURST_WINDOW_MS) {
      return compactInteractionTimes(state?.interactionTimes, now, windowMs).length
    }

    function interactionBurstLevel(state, now = Date.now(), windowMs = INTERACTION_BURST_WINDOW_MS) {
      return burstLevelForCount(interactionBurstCount(state, now, windowMs))
    }

    function applyDeltas(state, deltas, now) {
      const current = createEmotionState(state, now)
      const next = { ...current }
      for (const key of EMOTION_KEYS) {
        if (Object.prototype.hasOwnProperty.call(deltas, key)) next[key] = clampEmotion(current[key] + numeric(deltas[key], 0))
      }
      return next
    }

    /** Apply one user-originated interaction and update only the RAM telemetry. */
    function applyInteractionEmotion(
      state,
      kind = 'pet',
      { now = Date.now(), windowMs = INTERACTION_BURST_WINDOW_MS } = {},
    ) {
      const current = createEmotionState(state, now, { windowMs })
      const timestamp = validTimestamp(now) ?? Date.now()
      const interactionTimes = compactInteractionTimes(current.interactionTimes, timestamp, windowMs)
      interactionTimes.push(timestamp)
      const next = applyDeltas(current, INTERACTION_DELTAS[kind] ?? INTERACTION_DELTAS.pet, timestamp)
      next.interactionTimes = interactionTimes
      next.burstCount = interactionTimes.length
      next.burstLevel = burstLevelForCount(next.burstCount)
      next.lastInteractionAt = timestamp
      next.lastEvent = kind
      next.lastEventAt = timestamp
      next.lastUpdatedAt = timestamp
      return next
    }

    /** A tiny time-only drift keeps the layer alive without becoming personality. */
    function advanceEmotion(state, now = Date.now(), { windowMs = INTERACTION_BURST_WINDOW_MS } = {}) {
      const current = createEmotionState(state, now, { windowMs })
      const timestamp = validTimestamp(now) ?? Date.now()
      const previous = validTimestamp(current.lastUpdatedAt) ?? timestamp
      const minutes = Math.max(0, Math.min((timestamp - previous) / 60_000, 240))
      if (minutes <= 0) return current

      const next = applyDeltas(current, {
        happiness: -minutes * 0.00035,
        comfort: -minutes * 0.00015,
        energy: -minutes * 0.0002,
        curiosity: minutes * 0.0001,
      }, timestamp)
      next.interactionTimes = compactInteractionTimes(current.interactionTimes, timestamp, windowMs)
      next.burstCount = next.interactionTimes.length
      next.burstLevel = burstLevelForCount(next.burstCount)
      next.lastUpdatedAt = timestamp
      return next
    }

    /** Keep the existing persistent attachment as a read-only initial/refresh hint. */
    function syncAttachment(state, attachment, now = Date.now()) {
      const current = createEmotionState(state, now)
      const value = Number(attachment)
      if (!Number.isFinite(value)) return current
      if (Math.abs(current.attachment - clampEmotion(value)) < 0.000001) return current
      return { ...current, attachment: clampEmotion(value), lastUpdatedAt: validTimestamp(now) ?? Date.now() }
    }

    /** Dream is a presentation source; this flag never changes persistent state. */
    function setDreaming(state, dreaming, now = Date.now()) {
      const current = createEmotionState(state, now)
      const value = dreaming === true
      return value === current.dreaming
        ? current
        : { ...current, dreaming: value, lastUpdatedAt: validTimestamp(now) ?? Date.now() }
    }

    /** Return the configured weighted action for a random sample in [0, 1). */
    function chooseIdleAction(random = Math.random()) {
      const sample = Math.max(0, Math.min(0.999999, numeric(random, 0)))
      let cursor = 0
      for (const action of IDLE_ACTIONS) {
        cursor += action.probability
        if (sample < cursor) return action.kind
      }
      return IDLE_ACTIONS[IDLE_ACTIONS.length - 1].kind
    }

    /** Map interaction semantics to a short-lived visual feedback state. */
    function visualFeedbackForInteraction(
      state,
      kind = 'pet',
      now = Date.now(),
      windowMs = INTERACTION_BURST_WINDOW_MS,
    ) {
      const burst = interactionBurstLevel(state, now, windowMs)
      if (burst === INTERACTION_BURST_LEVELS.confused) return 'confused'
      if (kind === 'long-press') return 'relaxed'
      if (kind === 'play' || burst === INTERACTION_BURST_LEVELS.excited) return 'excited'
      return 'happy'
    }


    const PET_SPRITE_MAP = Object.freeze({
      idle: Object.freeze([SPRITES.idle, SPRITES['idle-3q'], SPRITES.blink]),
      happy: Object.freeze([SPRITES.playbow, SPRITES.jump]),
      thinking: Object.freeze([SPRITES.curious, SPRITES.surprised]),
      excited: Object.freeze([SPRITES.jump, SPRITES.playbow]),
      relaxed: Object.freeze([SPRITES['rest-curled'], SPRITES['rest-awake'], SPRITES.stretch]),
      waiting: Object.freeze([SPRITES.sit, SPRITES['idle-3q'], SPRITES.blink]),
      curious: Object.freeze([SPRITES.curious, SPRITES['idle-3q'], SPRITES.surprised]),
      confused: Object.freeze([SPRITES.curious, SPRITES.surprised, SPRITES['idle-3q']]),
      sleep: Object.freeze([SPRITES['sleep-curled'], SPRITES['sleep-side']]),
      dreaming: Object.freeze([SPRITES['sleep-curled'], SPRITES['sleep-side']]),
      walk: Object.freeze([
        'walk-right-1.png',
        'walk-right-2.png',
        'walk-right-3.png',
        'walk-right-4.png',
        'walk-right-5.png',
        'walk-right-6.png',
      ]),
    })

    const IDLE_ACTION_SPRITES = Object.freeze({
      blink: SPRITES.blink,
      stretch: SPRITES.stretch,
      yawn: SPRITES.sleepy,
      look_around: SPRITES['idle-3q'],
      change_pose: SPRITES.sit,
    })

    function spriteForVisualState(visualState, frame = 0, idleAction = null) {
      if (visualState === 'idle' && IDLE_ACTION_SPRITES[idleAction]) return IDLE_ACTION_SPRITES[idleAction]
      const frames = PET_SPRITE_MAP[visualState] ?? PET_SPRITE_MAP.idle
      const index = Math.abs(Math.trunc(Number(frame) || 0)) % frames.length
      return frames[index]
    }

    function spriteFramesForVisualState(visualState) {
      return PET_SPRITE_MAP[visualState] ?? PET_SPRITE_MAP.idle
    }


    function frameDelayForVisualState(visualState, config = {}) {
      const visualConfig = normalizePetVisualConfig(config)
      if (visualState === 'walk') return visualConfig.walkFrameMs
      if (visualState === 'thinking') return visualConfig.thinkingPulseMs
      if (visualState === 'happy' || visualState === 'excited') return 420
      if (visualState === 'relaxed') return 900
      if (visualState === 'confused' || visualState === 'curious') return 760
      if (visualState === 'waiting') return 2_200
      if (visualState === 'sleep' || visualState === 'dreaming') return 2_400
      return 2_800
    }

    function nextVisualFrame(frame) {
      return (Math.max(0, Math.trunc(Number(frame) || 0)) + 1) % 60
    }

    function spriteForAnimation(visualState, frame, idleAction = null) {
      return spriteForVisualState(visualState, frame, idleAction)
    }


    const STORAGE_KEY = 'vc-ai-pet:v0.1:client-state'
    const PRESENCE_POLL_MS = 1_000

    function load() {
      try {
        const value = globalThis.localStorage?.getItem(STORAGE_KEY)
        if (value) return JSON.parse(value)
      } catch {
        // Keep the overlay usable when storage is unavailable or corrupt.
      }
      return createInitialState()
    }

    function save(value) {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch {
        // Local persistence is best-effort; host persistence is authoritative.
      }
    }

    function emptyPresence() {
      return { chatPending: false, dreamRunning: false }
    }

    function samePresence(left, right) {
      return left?.chatPending === right?.chatPending && left?.dreamRunning === right?.dreamRunning
    }

    function sameVisualConfig(left, right) {
      return Object.keys(DEFAULT_PET_VISUAL_CONFIG).every((key) => left?.[key] === right?.[key])
    }

    function createPetOverlay({ assetBaseUrl, bridge = null }) {
      return function PetOverlay() {
        const [state, setState] = React.useState(load)
        const [pos, setPos] = React.useState({ x: null, y: null })
        const [chatOpen, setChatOpen] = React.useState(false)
        const [chatInput, setChatInput] = React.useState('')
        const [chatPending, setChatPending] = React.useState(false)
        const [chatMessages, setChatMessages] = React.useState([])
        const [hostPresence, setHostPresence] = React.useState(emptyPresence)
        const [hostVisualState, setHostVisualState] = React.useState(null)
        const [visualConfig, setVisualConfig] = React.useState(() => normalizePetVisualConfig(DEFAULT_PET_VISUAL_CONFIG))
        const [feedback, setFeedback] = React.useState(null)
        const [emotion, setEmotion] = React.useState(() => createEmotionState({ attachment: state.attachment }))
        const [idleAction, setIdleAction] = React.useState(null)
        const [frame, setFrame] = React.useState(0)
        const stateRef = React.useRef(state)
        const emotionRef = React.useRef(emotion)
        const clickTimer = React.useRef(null)
        const feedbackTimer = React.useRef(null)
        const longPressTimer = React.useRef(null)
        const idleActionTimer = React.useRef(null)
        const idleActionClearTimer = React.useRef(null)
        const presenceInFlight = React.useRef(false)
        const drag = React.useRef(null)
        const now = Date.now()

        const baseEnvironment = createPetEnvironment({
          petState: state,
          chatPending: chatPending || hostPresence.chatPending,
          dreamRunning: hostPresence.dreamRunning,
          chatOpen,
          config: visualConfig,
          now,
        })
        const emotionInteractionAt = Number(emotion.lastInteractionAt)
        const emotionRecentInteraction = Number.isFinite(emotionInteractionAt)
          && now >= emotionInteractionAt
          && now - emotionInteractionAt < visualConfig.waitingAfterInteractionMinutes * 60_000
        const environment = {
          ...baseEnvironment,
          recentInteraction: baseEnvironment.recentInteraction || emotionRecentInteraction,
        }
        const calculatedVisual = resolvePetVisualState({
          petState: state,
          environment,
          feedback,
          emotion,
          config: visualConfig,
          now,
        })
        const visual = hostVisualState ?? calculatedVisual
        const idleActionVisible = idleAction
          && idleAction.until > now
          && ['idle', 'waiting', 'curious', 'confused', 'relaxed'].includes(visual)
          ? idleAction
          : null
        const image = `${assetBaseUrl}/${spriteForAnimation(visual, frame, idleActionVisible?.kind)}`

        React.useEffect(() => {
          stateRef.current = state
        }, [state])

        React.useEffect(() => {
          emotionRef.current = emotion
        }, [emotion])

        React.useEffect(() => {
          let alive = true

          async function refreshState() {
            try {
              const remote = await bridge?.readState?.()
              if (!alive || !remote) return
              stateRef.current = remote
              setState(remote)
              save(remote)
              if (Number.isFinite(Number(remote.attachment))
                && Math.abs(Number(emotionRef.current.attachment) - Number(remote.attachment)) > 0.000001) {
                const nextEmotion = syncAttachment(emotionRef.current, remote.attachment)
                emotionRef.current = nextEmotion
                setEmotion(nextEmotion)
              }
            } catch {
              // The local state remains usable if the host is temporarily absent.
            }
          }

          async function refreshPresence() {
            if (presenceInFlight.current) return
            presenceInFlight.current = true
            try {
              const presence = await bridge?.readPresence?.()
              if (!alive || !presence || typeof presence !== 'object') return
              const nextPresence = {
                chatPending: presence.chatPending === true,
                dreamRunning: presence.dreamRunning === true,
              }
              setHostPresence((current) => samePresence(current, nextPresence) ? current : nextPresence)
              setHostVisualState([
                'idle', 'thinking', 'happy', 'excited', 'relaxed', 'waiting', 'curious', 'confused', 'sleep', 'dreaming', 'walk',
              ].includes(presence.visualState) ? presence.visualState : null)
              if (presence.emotion && typeof presence.emotion === 'object') {
                const nextEmotion = createEmotionState({ ...emotionRef.current, ...presence.emotion })
                emotionRef.current = nextEmotion
                setEmotion(nextEmotion)
              }
              if (emotionRef.current.dreaming !== nextPresence.dreamRunning) {
                const nextEmotion = setDreaming(emotionRef.current, nextPresence.dreamRunning)
                emotionRef.current = nextEmotion
                setEmotion(nextEmotion)
              }
              if (presence.visualConfig) {
                const nextConfig = normalizePetVisualConfig(presence.visualConfig)
                setVisualConfig((current) => sameVisualConfig(current, nextConfig) ? current : nextConfig)
              }
            } catch {
              // Presence is decorative; the pet remains interactive when it is unavailable.
            } finally {
              presenceInFlight.current = false
            }
          }

          void refreshState()
          void refreshPresence()
          const stateTimer = globalThis.setInterval?.(() => { void refreshState() }, PRESENCE_POLL_MS)
          const presenceTimer = globalThis.setInterval?.(() => { void refreshPresence() }, PRESENCE_POLL_MS)

          return () => {
            alive = false
            if (stateTimer !== undefined) globalThis.clearInterval?.(stateTimer)
            if (presenceTimer !== undefined) globalThis.clearInterval?.(presenceTimer)
          }
        }, [bridge])

        React.useEffect(() => {
          const id = globalThis.setInterval?.(() => {
            const current = stateRef.current
            const next = advanceState(current)
            stateRef.current = next
            setState(next)
            save(next)
            const nextEmotion = advanceEmotion(emotionRef.current, Date.now(), {
              windowMs: visualConfig.interactionBurstWindowMs,
            })
            emotionRef.current = nextEmotion
            setEmotion(nextEmotion)
            const write = bridge?.writeState?.(next)
            write?.catch?.(() => {})
          }, 10_000)
          return () => globalThis.clearInterval?.(id)
        }, [bridge, visualConfig.interactionBurstWindowMs])

        React.useEffect(() => {
          let alive = true

          function schedule() {
            if (!alive || typeof globalThis.setTimeout !== 'function') return
            const minimum = Math.min(visualConfig.idleActionMinMs, visualConfig.idleActionMaxMs)
            const maximum = Math.max(visualConfig.idleActionMinMs, visualConfig.idleActionMaxMs)
            const delay = minimum + Math.random() * (maximum - minimum)
            idleActionTimer.current = globalThis.setTimeout?.(() => {
              if (!alive) return
              const kind = chooseIdleAction(Math.random())
              const until = Date.now() + visualConfig.idleActionDurationMs
              setIdleAction({ kind, until })
              if (idleActionClearTimer.current !== null) globalThis.clearTimeout?.(idleActionClearTimer.current)
              idleActionClearTimer.current = globalThis.setTimeout?.(() => {
                setIdleAction((current) => current?.until === until ? null : current)
                idleActionClearTimer.current = null
              }, visualConfig.idleActionDurationMs) ?? null
              schedule()
            }, delay) ?? null
          }

          schedule()
          return () => {
            alive = false
            if (idleActionTimer.current !== null) globalThis.clearTimeout?.(idleActionTimer.current)
            if (idleActionClearTimer.current !== null) globalThis.clearTimeout?.(idleActionClearTimer.current)
            idleActionTimer.current = null
            idleActionClearTimer.current = null
          }
        }, [visualConfig.idleActionMinMs, visualConfig.idleActionMaxMs, visualConfig.idleActionDurationMs])

        React.useEffect(() => {
          setFrame(0)
          const id = globalThis.setInterval?.(
            () => setFrame((current) => nextVisualFrame(current)),
            frameDelayForVisualState(visual, visualConfig),
          )
          return () => globalThis.clearInterval?.(id)
        }, [visual, visualConfig.thinkingPulseMs, visualConfig.walkFrameMs])

        React.useEffect(() => () => {
          if (clickTimer.current !== null) globalThis.clearTimeout?.(clickTimer.current)
          if (feedbackTimer.current !== null) globalThis.clearTimeout?.(feedbackTimer.current)
          if (longPressTimer.current !== null) globalThis.clearTimeout?.(longPressTimer.current)
        }, [])

        function showFeedback(kind) {
          const duration = kind === 'excited'
            ? visualConfig.excitedDurationMs
            : kind === 'relaxed'
              ? visualConfig.relaxedDurationMs
              : kind === 'confused' || kind === 'curious'
                ? visualConfig.confusedDurationMs
                : visualConfig.happyDurationMs
          const until = Date.now() + duration
          setFeedback({ kind, until })

          if (feedbackTimer.current !== null) globalThis.clearTimeout?.(feedbackTimer.current)
          feedbackTimer.current = globalThis.setTimeout?.(() => {
            setFeedback((current) => current?.until === until ? null : current)
            feedbackTimer.current = null
          }, duration) ?? null
        }

        function updateEmotion(kind, now = Date.now()) {
          const next = applyInteractionEmotion(emotionRef.current, kind, {
            now,
            windowMs: visualConfig.interactionBurstWindowMs,
          })
          emotionRef.current = next
          setEmotion(next)
          return next
        }

        async function act(kind = 'pet') {
          const current = stateRef.current
          const next = interact(current, kind)
          stateRef.current = next
          setState(next)
          save(next)
          const emotionKind = kind === 'play' || kind === 'long-press' ? kind : 'pet'
          const nextEmotion = updateEmotion(emotionKind)
          showFeedback(visualFeedbackForInteraction(
            nextEmotion,
            emotionKind,
            Date.now(),
            visualConfig.interactionBurstWindowMs,
          ))

          try {
            const remote = await bridge?.interact?.(kind)
            if (!remote) return
            stateRef.current = remote
            setState(remote)
            save(remote)
          } catch {
            // Keep the local visual reaction even when the host request fails.
          }
        }

        function clearLongPressTimer() {
          if (longPressTimer.current !== null) globalThis.clearTimeout?.(longPressTimer.current)
          longPressTimer.current = null
        }

        function longPress() {
          if (!drag.current || drag.current.moved || drag.current.longPressed) return
          drag.current.longPressed = true
          const nextEmotion = updateEmotion('long-press')
          showFeedback(visualFeedbackForInteraction(
            nextEmotion,
            'long-press',
            Date.now(),
            visualConfig.interactionBurstWindowMs,
          ))
          // Use the established host interaction entry without turning a held
          // pointer into a synthetic local persistent state update.
          bridge?.interact?.('long-press')?.then?.((remote) => {
            if (!remote) return
            stateRef.current = remote
            setState(remote)
            save(remote)
          })?.catch?.(() => {})
        }

        function scheduleSingleClick() {
          if (clickTimer.current !== null) globalThis.clearTimeout?.(clickTimer.current)
          clickTimer.current = globalThis.setTimeout?.(() => {
            clickTimer.current = null
            const current = stateRef.current
            void act(current.current === 'sleep' ? 'wake' : 'pet')
          }, 220) ?? null
        }

        function doubleClick() {
          clearLongPressTimer()
          if (clickTimer.current !== null) {
            globalThis.clearTimeout?.(clickTimer.current)
            clickTimer.current = null
          }
          if (drag.current) drag.current.longPressed = true
          void act('play')
        }

        function appendChat(role, text) {
          setChatMessages((previous) => [...previous, { role, text }].slice(-8))
        }

        async function sendChat() {
          const text = chatInput.trim()
          if (!text || chatPending) return

          setChatInput('')
          appendChat('user', text)
          setChatPending(true)
          // This feedback is caused by the owner's send action. It is deliberately
          // scheduled before the host/model request so an assistant response can
          // never write emotion state.
          showFeedback('happy')

          try {
            const result = await bridge?.chat?.(text)
            if (result?.ok) {
              appendChat('pet', result.text)
            } else if (result?.unavailable) appendChat('pet', result.petLine || '花花先在旁边等主人。')
            else appendChat('pet', '花花脑袋刚刚卡了一下……')
          } catch {
            appendChat('pet', '花花脑袋刚刚卡了一下……')
          } finally {
            setChatPending(false)
          }
        }

        function down(event) {
          clearLongPressTimer()
          if (clickTimer.current !== null) {
            globalThis.clearTimeout?.(clickTimer.current)
            clickTimer.current = null
          }
          drag.current = {
            px: event.clientX,
            py: event.clientY,
            startX: pos.x ?? 0,
            startY: pos.y ?? 0,
            moved: false,
            longPressed: false,
          }
          event.currentTarget.setPointerCapture?.(event.pointerId)
          longPressTimer.current = globalThis.setTimeout?.(longPress, visualConfig.longPressMs) ?? null
        }

        function move(event) {
          if (!drag.current) return
          const dx = event.clientX - drag.current.px
          const dy = event.clientY - drag.current.py
          if (Math.abs(dx) + Math.abs(dy) > 5) {
            drag.current.moved = true
            clearLongPressTimer()
          }
          if (drag.current.moved) {
            setPos({ x: drag.current.startX + dx, y: drag.current.startY + dy })
          }
        }

        function up() {
          clearLongPressTimer()
          const moved = drag.current?.moved
          const longPressed = drag.current?.longPressed
          drag.current = null
          if (!moved && !longPressed) scheduleSingleClick()
        }

        function cancelPress() {
          clearLongPressTimer()
          drag.current = null
        }

        const stageClassName = [
          'vc-pet-stage',
          `vc-pet-visual-${visual}`,
          visual === 'walk' && visualConfig.ambientMoveEnabled ? 'vc-pet-ambient-move' : '',
          idleActionVisible ? `vc-pet-action-${idleActionVisible.kind.replaceAll('_', '-')}` : '',
        ].filter(Boolean).join(' ')

        return React.createElement(
          'div',
          {
            className: 'vc-pet-overlay-root',
            'data-pet-state': state.current,
            'data-pet-visual-state': visual,
            'data-pet-idle-action': idleActionVisible?.kind ?? '',
            'data-owner-working': environment.ownerWorking ? 'true' : 'false',
            style: pos.x == null ? undefined : { transform: `translate(${pos.x}px,${pos.y}px)` },
          },
          chatOpen && React.createElement(
            'section',
            { className: 'vc-pet-chat-bubble', 'aria-label': '和李花花聊天' },
            React.createElement(
              'header',
              { className: 'vc-pet-chat-header' },
              React.createElement('strong', null, '李花花'),
              React.createElement('button', { type: 'button', className: 'vc-pet-chat-close', onClick: () => setChatOpen(false), 'aria-label': '关闭聊天气泡' }, '×'),
            ),
            React.createElement(
              'div',
              { className: 'vc-pet-chat-messages', 'aria-live': 'polite' },
              chatMessages.length === 0 && React.createElement('p', { className: 'vc-pet-chat-empty' }, '🐶 在呀。'),
              chatMessages.map((message, index) => React.createElement(
                'p',
                { className: `vc-pet-chat-message vc-pet-chat-message-${message.role}`, key: `${message.role}-${index}` },
                React.createElement('b', null, message.role === 'user' ? '主人：' : '李花花：'),
                ' ', message.text,
              )),
              chatPending && React.createElement('p', { className: 'vc-pet-chat-thinking' }, '花花在想……'),
            ),
            React.createElement(
              'form',
              { className: 'vc-pet-chat-composer', onSubmit: (event) => { event.preventDefault(); void sendChat() } },
              React.createElement('input', {
                type: 'text',
                maxLength: 500,
                value: chatInput,
                disabled: chatPending,
                placeholder: '和花花说句话……',
                onChange: (event) => setChatInput(event.target.value),
                'aria-label': '和李花花说句话',
              }),
              React.createElement('button', { type: 'submit', disabled: chatPending || !chatInput.trim(), 'aria-label': '发送给李花花' }, '↑'),
            ),
          ),
          React.createElement('button', { className: 'vc-pet-chat-toggle', type: 'button', title: '和李花花说话', 'aria-label': '和李花花说话', onClick: () => setChatOpen(true) }, '💬'),
          React.createElement(
            'div',
            { className: stageClassName },
            visual === 'thinking' && React.createElement('span', { className: 'vc-pet-thought-mark', 'aria-hidden': true }, '?'),
            visual === 'happy' && React.createElement('span', { className: 'vc-pet-happy-mark', 'aria-hidden': true }, '♥'),
            visual === 'excited' && React.createElement('span', { className: 'vc-pet-excited-mark', 'aria-hidden': true }, '✦'),
            visual === 'confused' && React.createElement('span', { className: 'vc-pet-confused-mark', 'aria-hidden': true }, '?'),
            visual === 'sleep' && visualConfig.zzzEnabled && React.createElement('span', { className: 'vc-pet-sleep-z', 'aria-hidden': true }, 'z'),
            visual === 'dreaming' && React.createElement(
              'div',
              { className: 'vc-pet-dream-mark', 'aria-hidden': true },
              React.createElement('span', { className: 'vc-pet-dream-moon' }, '☾'),
              React.createElement('span', { className: 'vc-pet-dream-bubble' }, '· ·'),
              React.createElement('span', { className: 'vc-pet-dream-star vc-pet-dream-star-one' }, '✦'),
              React.createElement('span', { className: 'vc-pet-dream-star vc-pet-dream-star-two' }, '✧'),
              visualConfig.zzzEnabled && React.createElement('span', { className: 'vc-pet-dream-z vc-pet-dream-z-one' }, 'z'),
              visualConfig.zzzEnabled && React.createElement('span', { className: 'vc-pet-dream-z vc-pet-dream-z-two' }, 'z'),
              visualConfig.zzzEnabled && React.createElement('span', { className: 'vc-pet-dream-z vc-pet-dream-z-three' }, 'Z'),
            ),
            React.createElement(
              'button',
              {
                className: 'vc-pet-hitbox',
                type: 'button',
                title: '李花花',
                onPointerDown: down,
                onPointerMove: move,
                onPointerUp: up,
                onPointerCancel: cancelPress,
                onDoubleClick: doubleClick,
                'aria-label': '李花花 AI pet',
              },
              React.createElement('img', {
                className: `vc-pet-sprite vc-pet-sprite-${visual}`,
                src: image,
                draggable: false,
                alt: '',
              }),
            ),
          ),
        )
      }
    }


    const inject = ['slots', 'connection'];

    function apply(ctx) {
      installCss();
      const bridge = createBridge(ctx.connection);
      const PetOverlay = createPetOverlay({ assetBaseUrl: '/vc-ai-pet/assets', bridge });
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'vc-ai-pet',
        order: 40
      }, PetOverlay));
    }

    function createBridge(connection) {
      const call = async (method, args) => {
        const response = await connection.rpc.call('/vc-ai-pet', method, { args });
        if (!response?.ok) throw new Error('vc-ai-pet RPC failed');
        return response.value;
      };
      return {
        readState: () => call('readState', {}),
        readPresence: () => call('readPresence', {}),
        interact: (kind) => call('interact', { kind }),
        chat: (userText) => call('chat', { userText })
      };
    }

    function installCss() {
      if (document.querySelector('style[data-vc-ai-pet]')) return;
      const tag = document.createElement('style');
      tag.dataset.vcAiPet = 'v0.1';
      tag.textContent = ".vc-pet-overlay-root {\n  position: fixed;\n  right: 24px;\n  bottom: 18px;\n  z-index: 40;\n  pointer-events: none;\n  user-select: none;\n  contain: layout style;\n}\n\n.vc-pet-stage {\n  position: relative;\n  width: 126px;\n  height: 126px;\n  isolation: isolate;\n}\n\n.vc-pet-hitbox {\n  position: relative;\n  z-index: 2;\n  width: 126px;\n  height: 126px;\n  padding: 0;\n  border: 0;\n  background: transparent;\n  cursor: grab;\n  pointer-events: auto;\n  touch-action: none;\n}\n\n.vc-pet-hitbox:active { cursor: grabbing; }\n\n.vc-pet-sprite {\n  width: 126px;\n  height: 126px;\n  object-fit: contain;\n  image-rendering: crisp-edges;\n  image-rendering: pixelated;\n  pointer-events: none;\n  filter: drop-shadow(0 5px 7px rgba(0, 0, 0, .16));\n  transform-origin: 50% 100%;\n}\n\n.vc-pet-visual-idle .vc-pet-sprite { animation: vc-pet-idle-breathe 3.8s ease-in-out infinite; }\n.vc-pet-visual-thinking .vc-pet-sprite { animation: vc-pet-thinking-tilt 1.4s ease-in-out infinite alternate; }\n.vc-pet-visual-happy .vc-pet-sprite { animation: vc-pet-hop .42s ease-out 1; }\n.vc-pet-visual-excited .vc-pet-sprite { animation: vc-pet-excited-hop .55s cubic-bezier(.2, .9, .35, 1.2) 2; }\n.vc-pet-visual-relaxed .vc-pet-sprite { animation: vc-pet-relaxed-breathe 2.8s ease-in-out infinite; }\n.vc-pet-visual-waiting .vc-pet-sprite { animation: vc-pet-waiting-breathe 4.6s ease-in-out infinite; }\n.vc-pet-visual-curious .vc-pet-sprite { animation: vc-pet-curious-tilt 1.5s ease-in-out infinite alternate; }\n.vc-pet-visual-confused .vc-pet-sprite { animation: vc-pet-confused-tilt 1.1s ease-in-out infinite alternate; }\n.vc-pet-visual-sleep .vc-pet-sprite { animation: vc-pet-sleep-breathe 3s ease-in-out infinite; }\n.vc-pet-visual-dreaming .vc-pet-sprite { animation: vc-pet-dream-breathe 2.5s ease-in-out infinite; }\n.vc-pet-visual-walk .vc-pet-sprite { animation: vc-pet-walk-bob .3s steps(2, end) infinite; }\n\n.vc-pet-ambient-move { animation: vc-pet-small-walk 3.8s ease-in-out infinite alternate; }\n\n.vc-pet-thought-mark,\n.vc-pet-happy-mark,\n.vc-pet-excited-mark,\n.vc-pet-confused-mark,\n.vc-pet-sleep-z,\n.vc-pet-dream-mark {\n  position: absolute;\n  z-index: 3;\n  pointer-events: none;\n  font-family: ui-rounded, \"Segoe UI Symbol\", system-ui, sans-serif;\n  text-shadow: 0 1px 2px rgba(15, 23, 42, .18);\n}\n\n.vc-pet-thought-mark {\n  top: 7px;\n  right: 5px;\n  display: grid;\n  width: 25px;\n  height: 25px;\n  place-items: center;\n  border: 2px solid #bfdbfe;\n  border-radius: 50%;\n  background: #eff6ff;\n  color: #2563eb;\n  font: 700 17px/1 ui-rounded, system-ui, sans-serif;\n  animation: vc-pet-thought-pulse 1.1s ease-in-out infinite;\n}\n\n.vc-pet-happy-mark {\n  top: 9px;\n  right: 11px;\n  color: #fb7185;\n  font-size: 25px;\n  animation: vc-pet-happy-pop .8s ease-out both;\n}\n\n.vc-pet-excited-mark {\n  top: 5px;\n  right: 5px;\n  color: #f59e0b;\n  font-size: 30px;\n  animation: vc-pet-spark .62s ease-in-out infinite alternate;\n}\n\n.vc-pet-confused-mark {\n  top: 5px;\n  right: 6px;\n  display: grid;\n  width: 27px;\n  height: 27px;\n  place-items: center;\n  border: 2px solid #c4b5fd;\n  border-radius: 50%;\n  background: #f5f3ff;\n  color: #7c3aed;\n  font: 800 18px/1 ui-rounded, system-ui, sans-serif;\n  animation: vc-pet-confused-pop 1s ease-in-out infinite alternate;\n}\n\n.vc-pet-sleep-z {\n  top: 9px;\n  right: 8px;\n  color: #60a5fa;\n  font-size: 18px;\n  font-weight: 800;\n  animation: vc-pet-z-float 2.4s ease-in-out infinite;\n}\n\n.vc-pet-dream-mark {\n  top: 0;\n  right: -2px;\n  width: 58px;\n  height: 56px;\n  color: #7c83d8;\n}\n\n.vc-pet-dream-moon {\n  position: absolute;\n  top: 3px;\n  left: 1px;\n  color: #8b92e6;\n  font-size: 31px;\n  line-height: 1;\n  animation: vc-pet-moon-glow 2.5s ease-in-out infinite;\n}\n\n.vc-pet-dream-bubble {\n  position: absolute;\n  top: 25px;\n  left: 11px;\n  display: grid;\n  width: 31px;\n  height: 19px;\n  place-items: center;\n  border: 1px solid rgba(124, 131, 216, .55);\n  border-radius: 50%;\n  background: rgba(238, 242, 255, .84);\n  color: #818cf8;\n  font-size: 10px;\n  letter-spacing: 2px;\n  animation: vc-pet-dream-bubble-float 2.5s ease-in-out infinite;\n}\n\n.vc-pet-dream-star {\n  position: absolute;\n  color: #fbbf24;\n  font-size: 12px;\n  line-height: 1;\n  animation: vc-pet-dream-star-twinkle 1.6s ease-in-out infinite alternate;\n}\n\n.vc-pet-dream-star-one { top: 31px; left: 0; }\n.vc-pet-dream-star-two { top: 1px; left: 37px; font-size: 10px; animation-delay: -.7s; }\n\n.vc-pet-dream-z {\n  position: absolute;\n  color: #60a5fa;\n  font-weight: 800;\n  line-height: 1;\n  animation: vc-pet-z-float 2.3s ease-in-out infinite;\n}\n\n.vc-pet-dream-z-one { top: 26px; left: 22px; font-size: 13px; animation-delay: -.2s; }\n.vc-pet-dream-z-two { top: 16px; left: 34px; font-size: 16px; animation-delay: -.8s; }\n.vc-pet-dream-z-three { top: 4px; left: 45px; font-size: 19px; animation-delay: -1.4s; }\n\n.vc-pet-overlay-root[data-owner-working=\"true\"] .vc-pet-sprite { filter: drop-shadow(0 4px 6px rgba(0, 0, 0, .13)); }\n\n/* Probability-selected idle actions. The timer chooses these in RAM; CSS\n   supplies the brief, low-cost motion and then the action expires. */\n.vc-pet-action-tail-move .vc-pet-sprite { animation: vc-pet-tail-wiggle .72s ease-in-out 2; }\n.vc-pet-action-stretch .vc-pet-sprite { animation: vc-pet-stretch .9s ease-in-out 1; }\n.vc-pet-action-yawn .vc-pet-sprite { animation: vc-pet-yawn 1.1s ease-in-out 1; }\n.vc-pet-action-look-around .vc-pet-sprite { animation: vc-pet-look-around 1.2s ease-in-out 1; }\n.vc-pet-action-change-pose .vc-pet-sprite { animation: vc-pet-change-pose .85s ease-in-out 1; }\n.vc-pet-action-blink .vc-pet-sprite { animation: vc-pet-blink .42s ease-in-out 2; }\n\n.vc-pet-chat-toggle {\n  position: absolute;\n  z-index: 5;\n  right: 2px;\n  bottom: 100px;\n  width: 30px;\n  height: 30px;\n  border: 1px solid rgba(100, 116, 139, .45);\n  border-radius: 999px;\n  background: #fff;\n  color: #334155;\n  box-shadow: 0 2px 8px rgba(15, 23, 42, .18);\n  cursor: pointer;\n  pointer-events: auto;\n  font-size: 15px;\n  line-height: 1;\n}\n\n.vc-pet-chat-bubble {\n  position: absolute;\n  z-index: 5;\n  right: 0;\n  bottom: 132px;\n  width: 286px;\n  max-width: calc(100vw - 32px);\n  box-sizing: border-box;\n  padding: 10px;\n  border: 1px solid rgba(100, 116, 139, .38);\n  border-radius: 14px;\n  background: #fff;\n  color: #1e293b;\n  box-shadow: 0 8px 22px rgba(15, 23, 42, .2);\n  font: 13px/1.45 system-ui, sans-serif;\n  pointer-events: auto;\n}\n\n.vc-pet-chat-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 6px;\n}\n\n.vc-pet-chat-close {\n  width: 24px;\n  height: 24px;\n  padding: 0;\n  border: 0;\n  border-radius: 6px;\n  background: transparent;\n  color: #64748b;\n  cursor: pointer;\n  font-size: 20px;\n  line-height: 1;\n}\n\n.vc-pet-chat-close:hover { background: #f1f5f9; }\n.vc-pet-chat-messages { max-height: 196px; overflow-y: auto; padding: 2px 1px; }\n.vc-pet-chat-messages p { margin: 0 0 7px; white-space: pre-wrap; overflow-wrap: anywhere; }\n.vc-pet-chat-empty { color: #475569; }\n.vc-pet-chat-message-user { color: #334155; }\n.vc-pet-chat-message-pet { color: #0f766e; }\n.vc-pet-chat-thinking { color: #64748b; font-style: italic; }\n\n.vc-pet-chat-composer { display: flex; gap: 6px; margin-top: 8px; }\n.vc-pet-chat-composer input {\n  min-width: 0;\n  flex: 1;\n  padding: 7px 8px;\n  border: 1px solid #94a3b8;\n  border-radius: 8px;\n  background: #fff;\n  color: #1e293b;\n  font: inherit;\n}\n\n.vc-pet-chat-composer button {\n  width: 31px;\n  border: 0;\n  border-radius: 8px;\n  background: #0f766e;\n  color: #fff;\n  cursor: pointer;\n  font: 600 16px/1 system-ui;\n}\n\n.vc-pet-chat-composer button:disabled,\n.vc-pet-chat-composer input:disabled { cursor: not-allowed; opacity: .58; }\n\n@keyframes vc-pet-idle-breathe {\n  50% { transform: translateY(-1px) scale(1.012, .99); }\n}\n\n@keyframes vc-pet-thinking-tilt {\n  from { transform: rotate(-1deg) translateY(0); }\n  to { transform: rotate(2deg) translateY(-1px); }\n}\n\n@keyframes vc-pet-hop {\n  45% { transform: translateY(-10px) scale(1.025, .98); }\n  100% { transform: translateY(0) scale(1); }\n}\n\n@keyframes vc-pet-excited-hop {\n  45% { transform: translateY(-14px) scale(1.04, .96); }\n  100% { transform: translateY(0) scale(1); }\n}\n\n@keyframes vc-pet-relaxed-breathe {\n  50% { transform: translateY(2px) scale(1.026, .972); }\n}\n\n@keyframes vc-pet-waiting-breathe {\n  50% { transform: translateY(-1px) scale(1.01, .995); }\n}\n\n@keyframes vc-pet-curious-tilt {\n  from { transform: rotate(-3deg) translateY(0); }\n  to { transform: rotate(4deg) translateY(-1px); }\n}\n\n@keyframes vc-pet-confused-tilt {\n  from { transform: rotate(-5deg) translateY(0); }\n  to { transform: rotate(6deg) translateY(-1px); }\n}\n\n@keyframes vc-pet-sleep-breathe {\n  50% { transform: scale(1.018, .988); }\n}\n\n@keyframes vc-pet-dream-breathe {\n  50% { transform: translateY(-2px) scale(1.02, .986); }\n}\n\n@keyframes vc-pet-walk-bob {\n  50% { transform: translateY(-2px); }\n}\n\n@keyframes vc-pet-small-walk {\n  from { transform: translateX(-5px); }\n  to { transform: translateX(6px); }\n}\n\n@keyframes vc-pet-thought-pulse {\n  50% { transform: scale(1.1); opacity: .78; }\n}\n\n@keyframes vc-pet-happy-pop {\n  0% { transform: translateY(8px) scale(.55); opacity: 0; }\n  45% { opacity: 1; }\n  100% { transform: translateY(-8px) scale(1); opacity: 0; }\n}\n\n@keyframes vc-pet-spark {\n  to { transform: rotate(16deg) scale(1.12); opacity: .72; }\n}\n\n@keyframes vc-pet-confused-pop {\n  to { transform: translateY(-2px) rotate(-7deg); opacity: .72; }\n}\n\n@keyframes vc-pet-dream-bubble-float {\n  50% { transform: translate(2px, -3px) scale(1.04); opacity: .72; }\n}\n\n@keyframes vc-pet-dream-star-twinkle {\n  to { transform: scale(1.35) rotate(10deg); opacity: .62; }\n}\n\n@keyframes vc-pet-tail-wiggle {\n  25% { transform: rotate(-2deg) translateX(-1px); }\n  75% { transform: rotate(2deg) translateX(1px); }\n}\n\n@keyframes vc-pet-stretch {\n  45% { transform: translateY(2px) scale(1.04, .95); }\n  100% { transform: translateY(0) scale(1); }\n}\n\n@keyframes vc-pet-yawn {\n  35% { transform: translateY(1px) scale(1.03, .97); }\n  70% { transform: translateY(-1px) scale(.99, 1.01); }\n}\n\n@keyframes vc-pet-look-around {\n  35% { transform: rotate(-4deg); }\n  70% { transform: rotate(4deg); }\n}\n\n@keyframes vc-pet-change-pose {\n  50% { transform: translateY(2px) scale(.97, 1.03); }\n}\n\n@keyframes vc-pet-blink {\n  45% { opacity: .25; }\n}\n\n@keyframes vc-pet-z-float {\n  50% { transform: translate(4px, -8px); opacity: .7; }\n}\n\n@keyframes vc-pet-moon-glow {\n  50% { transform: scale(1.08); color: #a5b4fc; text-shadow: 0 0 7px rgba(165, 180, 252, .8); }\n}\n\n@media (prefers-color-scheme: dark) {\n  .vc-pet-chat-bubble { background: #1e293b; color: #e2e8f0; border-color: #475569; }\n  .vc-pet-chat-toggle { background: #1e293b; color: #f8fafc; border-color: #64748b; }\n  .vc-pet-chat-close { color: #cbd5e1; }\n  .vc-pet-chat-close:hover { background: #334155; }\n  .vc-pet-chat-empty,\n  .vc-pet-chat-thinking { color: #cbd5e1; }\n  .vc-pet-chat-message-user { color: #e2e8f0; }\n  .vc-pet-chat-message-pet { color: #5eead4; }\n  .vc-pet-chat-composer input { background: #0f172a; color: #f8fafc; border-color: #64748b; }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .vc-pet-stage,\n  .vc-pet-sprite,\n  .vc-pet-thought-mark,\n  .vc-pet-happy-mark,\n  .vc-pet-excited-mark,\n  .vc-pet-confused-mark,\n  .vc-pet-sleep-z,\n  .vc-pet-dream-moon,\n  .vc-pet-dream-z,\n  .vc-pet-dream-bubble,\n  .vc-pet-dream-star { animation: none !important; }\n}\n";
      document.head.appendChild(tag);
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
