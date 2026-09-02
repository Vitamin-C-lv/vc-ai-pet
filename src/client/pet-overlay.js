import React from 'react'
import { advanceState, createInitialState, interact } from '../core/pet-state-engine.js'
import { createPetEnvironment } from './pet-environment.js'
import { frameDelayForVisualState, nextVisualFrame, spriteForAnimation } from './pet-animation.js'
import { DEFAULT_PET_VISUAL_CONFIG, normalizePetVisualConfig, resolvePetVisualState } from './pet-visual-state.js'

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

export function createPetOverlay({ assetBaseUrl, bridge = null }) {
  return function PetOverlay() {
    const [state, setState] = React.useState(load)
    const [pos, setPos] = React.useState({ x: null, y: null })
    const [chatOpen, setChatOpen] = React.useState(false)
    const [chatInput, setChatInput] = React.useState('')
    const [chatPending, setChatPending] = React.useState(false)
    const [chatMessages, setChatMessages] = React.useState([])
    const [hostPresence, setHostPresence] = React.useState(emptyPresence)
    const [visualConfig, setVisualConfig] = React.useState(() => normalizePetVisualConfig(DEFAULT_PET_VISUAL_CONFIG))
    const [feedback, setFeedback] = React.useState(null)
    const [frame, setFrame] = React.useState(0)
    const stateRef = React.useRef(state)
    const clickTimer = React.useRef(null)
    const feedbackTimer = React.useRef(null)
    const presenceInFlight = React.useRef(false)
    const drag = React.useRef(null)
    const now = Date.now()

    const environment = createPetEnvironment({
      petState: state,
      chatPending: chatPending || hostPresence.chatPending,
      dreamRunning: hostPresence.dreamRunning,
      config: visualConfig,
      now,
    })
    const visual = resolvePetVisualState({
      petState: state,
      environment,
      feedback,
      config: visualConfig,
      now,
    })
    const image = `${assetBaseUrl}/${spriteForAnimation(visual, frame)}`

    React.useEffect(() => {
      stateRef.current = state
    }, [state])

    React.useEffect(() => {
      let alive = true

      async function refreshState() {
        try {
          const remote = await bridge?.readState?.()
          if (!alive || !remote) return
          stateRef.current = remote
          setState(remote)
          save(remote)
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
      const presenceTimer = globalThis.setInterval?.(() => { void refreshPresence() }, PRESENCE_POLL_MS)

      return () => {
        alive = false
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
        const write = bridge?.writeState?.(next)
        write?.catch?.(() => {})
      }, 10_000)
      return () => globalThis.clearInterval?.(id)
    }, [bridge])

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
    }, [])

    function showFeedback(kind) {
      const duration = kind === 'excited'
        ? visualConfig.excitedDurationMs
        : visualConfig.happyDurationMs
      const until = Date.now() + duration
      setFeedback({ kind, until })

      if (feedbackTimer.current !== null) globalThis.clearTimeout?.(feedbackTimer.current)
      feedbackTimer.current = globalThis.setTimeout?.(() => {
        setFeedback((current) => current?.until === until ? null : current)
        feedbackTimer.current = null
      }, duration) ?? null
    }

    async function act(kind = 'pet') {
      const current = stateRef.current
      const next = interact(current, kind)
      stateRef.current = next
      setState(next)
      save(next)
      showFeedback(kind === 'play' ? 'excited' : 'happy')

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

    function scheduleSingleClick() {
      if (clickTimer.current !== null) globalThis.clearTimeout?.(clickTimer.current)
      clickTimer.current = globalThis.setTimeout?.(() => {
        clickTimer.current = null
        const current = stateRef.current
        void act(current.current === 'sleep' ? 'wake' : 'pet')
      }, 220) ?? null
    }

    function doubleClick() {
      if (clickTimer.current !== null) {
        globalThis.clearTimeout?.(clickTimer.current)
        clickTimer.current = null
      }
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

      try {
        const result = await bridge?.chat?.(text)
        if (result?.ok) {
          appendChat('pet', result.text)
          showFeedback('happy')
        } else if (result?.unavailable) appendChat('pet', result.petLine || '花花先在旁边等主人。')
        else appendChat('pet', '花花脑袋刚刚卡了一下……')
      } catch {
        appendChat('pet', '花花脑袋刚刚卡了一下……')
      } finally {
        setChatPending(false)
      }
    }

    function down(event) {
      drag.current = {
        px: event.clientX,
        py: event.clientY,
        startX: pos.x ?? 0,
        startY: pos.y ?? 0,
        moved: false,
      }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }

    function move(event) {
      if (!drag.current) return
      const dx = event.clientX - drag.current.px
      const dy = event.clientY - drag.current.py
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.current.moved = true
      if (drag.current.moved) {
        setPos({ x: drag.current.startX + dx, y: drag.current.startY + dy })
      }
    }

    function up() {
      const moved = drag.current?.moved
      drag.current = null
      if (!moved) scheduleSingleClick()
    }

    const stageClassName = [
      'vc-pet-stage',
      `vc-pet-visual-${visual}`,
      visual === 'walk' && visualConfig.ambientMoveEnabled ? 'vc-pet-ambient-move' : '',
    ].filter(Boolean).join(' ')

    return React.createElement(
      'div',
      {
        className: 'vc-pet-overlay-root',
        'data-pet-state': state.current,
        'data-pet-visual-state': visual,
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
        visual === 'sleep' && visualConfig.zzzEnabled && React.createElement('span', { className: 'vc-pet-sleep-z', 'aria-hidden': true }, 'z'),
        visual === 'dreaming' && visualConfig.zzzEnabled && React.createElement(
          'div',
          { className: 'vc-pet-dream-mark', 'aria-hidden': true },
          React.createElement('span', { className: 'vc-pet-dream-moon' }, '☾'),
          React.createElement('span', { className: 'vc-pet-dream-z vc-pet-dream-z-one' }, 'z'),
          React.createElement('span', { className: 'vc-pet-dream-z vc-pet-dream-z-two' }, 'z'),
          React.createElement('span', { className: 'vc-pet-dream-z vc-pet-dream-z-three' }, 'Z'),
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
