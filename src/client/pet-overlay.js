import React from'react';import{advanceState,createInitialState,interact,chooseVisual}from'../core/pet-state-engine.js';import{SPRITES}from'./sprite-catalog.js';

const STORAGE_KEY = 'vc-ai-pet:v0.1:client-state';

function load() {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (value) return JSON.parse(value);
  } catch {
    // Keep the overlay usable when storage is unavailable or corrupt.
  }
  return createInitialState();
}

function save(value) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Local persistence is best-effort; host persistence is authoritative.
  }
}

export function createPetOverlay({ assetBaseUrl, bridge = null }) {
  return function PetOverlay() {
    const [state, setState] = React.useState(load);
    const [visual, setVisual] = React.useState(() => chooseVisual(state));
    const [pos, setPos] = React.useState({ x: null, y: null });
    const [chatOpen, setChatOpen] = React.useState(false);
    const [chatInput, setChatInput] = React.useState('');
    const [chatPending, setChatPending] = React.useState(false);
    const [chatMessages, setChatMessages] = React.useState([]);
    const stateRef = React.useRef(state);
    const clickTimer = React.useRef(null);
    const drag = React.useRef(null);

    React.useEffect(() => {
      stateRef.current = state;
    }, [state]);

    React.useEffect(() => {
      let alive = true;
      (async () => {
        try {
          const remote = await bridge?.readState?.();
          if (!alive || !remote) return;
          stateRef.current = remote;
          setState(remote);
          save(remote);
          setVisual(chooseVisual(remote));
        } catch {
          // The local state remains usable if the host is temporarily absent.
        }
      })();
      return () => {
        alive = false;
      };
    }, []);

    React.useEffect(() => {
      const id = globalThis.setInterval?.(() => {
        const current = stateRef.current;
        const next = advanceState(current);
        stateRef.current = next;
        setState(next);
        save(next);
        setVisual(chooseVisual(next));
        const write = bridge?.writeState?.(next);
        write?.catch?.(() => {});
      }, 10000);
      return () => globalThis.clearInterval?.(id);
    }, []);

    React.useEffect(() => () => {
      if (clickTimer.current !== null) {
        globalThis.clearTimeout?.(clickTimer.current);
        clickTimer.current = null;
      }
    }, []);

    async function act(kind = 'pet') {
      const current = stateRef.current;
      const next = interact(current, kind);
      stateRef.current = next;
      setState(next);
      save(next);
      setVisual(chooseVisual(next, 0.05));

      try {
        const remote = await bridge?.interact?.(kind);
        if (!remote) return;
        stateRef.current = remote;
        setState(remote);
        save(remote);
        setVisual(chooseVisual(remote, 0.05));
      } catch {
        // Keep the local visual reaction even when the host request fails.
      }
    }

    function scheduleSingleClick() {
      if (clickTimer.current !== null) {
        globalThis.clearTimeout?.(clickTimer.current);
      }
      clickTimer.current = globalThis.setTimeout(() => {
        clickTimer.current = null;
        const current = stateRef.current;
        void act(current.current === 'sleep' ? 'wake' : 'pet');
      }, 220);
    }

    function doubleClick() {
      if (clickTimer.current !== null) {
        globalThis.clearTimeout?.(clickTimer.current);
        clickTimer.current = null;
      }
      void act('play');
    }

    function appendChat(role, text) {
      setChatMessages((previous) => [...previous, { role, text }].slice(-8));
    }

    async function sendChat() {
      const text = chatInput.trim();
      if (!text || chatPending) return;

      setChatInput('');
      appendChat('user', text);
      setChatPending(true);

      try {
        const result = await bridge?.chat?.(text);
        if (result?.ok) appendChat('pet', result.text);
        else if (result?.unavailable) appendChat('pet', result.petLine || '花花先在旁边等主人。');
        else appendChat('pet', '花花脑袋刚刚卡了一下……');
      } catch {
        appendChat('pet', '花花脑袋刚刚卡了一下……');
      } finally {
        setChatPending(false);
      }
    }

    function down(event) {
      drag.current = {
        px: event.clientX,
        py: event.clientY,
        startX: pos.x ?? 0,
        startY: pos.y ?? 0,
        moved: false
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }

    function move(event) {
      if (!drag.current) return;
      const dx = event.clientX - drag.current.px;
      const dy = event.clientY - drag.current.py;
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.current.moved = true;
      if (drag.current.moved) {
        setPos({ x: drag.current.startX + dx, y: drag.current.startY + dy });
      }
    }

    function up() {
      const moved = drag.current?.moved;
      drag.current = null;
      if (!moved) scheduleSingleClick();
    }

    const image = visual === 'walk'
      ? `${assetBaseUrl}/walk-right-3.png`
      : `${assetBaseUrl}/${SPRITES[visual] ?? SPRITES.idle}`;

    return React.createElement(
      'div',
      {
        className: 'vc-pet-overlay-root',
        'data-pet-state': state.current,
        style: pos.x == null ? undefined : { transform: `translate(${pos.x}px,${pos.y}px)` }
      },
      chatOpen && React.createElement(
        'section',
        { className: 'vc-pet-chat-bubble', 'aria-label': '和李花花聊天' },
        React.createElement(
          'header',
          { className: 'vc-pet-chat-header' },
          React.createElement('strong', null, '李花花'),
          React.createElement('button', { type: 'button', className: 'vc-pet-chat-close', onClick: () => setChatOpen(false), 'aria-label': '关闭聊天气泡' }, '×')
        ),
        React.createElement(
          'div',
          { className: 'vc-pet-chat-messages', 'aria-live': 'polite' },
          chatMessages.length === 0 && React.createElement('p', { className: 'vc-pet-chat-empty' }, '🐶 在呀。'),
          chatMessages.map((message, index) => React.createElement(
            'p',
            { className: `vc-pet-chat-message vc-pet-chat-message-${message.role}`, key: `${message.role}-${index}` },
            React.createElement('b', null, message.role === 'user' ? '主人：' : '李花花：'),
            ' ', message.text
          )),
          chatPending && React.createElement('p', { className: 'vc-pet-chat-thinking' }, '花花在想……')
        ),
        React.createElement(
          'form',
          { className: 'vc-pet-chat-composer', onSubmit: (event) => { event.preventDefault(); void sendChat(); } },
          React.createElement('input', {
            type: 'text',
            maxLength: 500,
            value: chatInput,
            disabled: chatPending,
            placeholder: '和花花说句话……',
            onChange: (event) => setChatInput(event.target.value),
            'aria-label': '和李花花说句话'
          }),
          React.createElement('button', { type: 'submit', disabled: chatPending || !chatInput.trim(), 'aria-label': '发送给李花花' }, '↑')
        )
      ),
      React.createElement('button', { className: 'vc-pet-chat-toggle', type: 'button', title: '和李花花说话', 'aria-label': '和李花花说话', onClick: () => setChatOpen(true) }, '💬'),
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
          'aria-label': '李花花 AI pet'
        },
        React.createElement('img', {
          className: `vc-pet-sprite vc-pet-state-${state.current}`,
          src: image,
          draggable: false,
          alt: ''
        })
      )
    );
  };
}
