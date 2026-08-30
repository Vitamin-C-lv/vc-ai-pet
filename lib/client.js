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

    function createPetOverlay({ assetBaseUrl, bridge = null }) {
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
        interact: (kind) => call('interact', { kind }),
        chat: (userText) => call('chat', { userText })
      };
    }

    function installCss() {
      if (document.querySelector('style[data-vc-ai-pet]')) return;
      const tag = document.createElement('style');
      tag.dataset.vcAiPet = 'v0.1';
      tag.textContent = ".vc-pet-overlay-root{position:fixed;right:24px;bottom:18px;z-index:40;pointer-events:none;user-select:none;contain:layout style}.vc-pet-hitbox{width:126px;height:126px;padding:0;border:0;background:transparent;cursor:grab;pointer-events:auto;touch-action:none}.vc-pet-hitbox:active{cursor:grabbing}.vc-pet-sprite{width:126px;height:126px;object-fit:contain;image-rendering:pixelated;pointer-events:none;filter:drop-shadow(0 5px 7px rgba(0,0,0,.16));transform-origin:50% 100%}.vc-pet-state-happy{animation:vc-pet-hop .35s ease-out 1}.vc-pet-state-curious{animation:vc-pet-tilt 1.8s ease-in-out infinite alternate}.vc-pet-state-sleep{animation:vc-pet-breathe 2.8s ease-in-out infinite}.vc-pet-state-walk{animation:vc-pet-bob .42s steps(2,end) infinite}.vc-pet-chat-toggle{position:absolute;right:2px;bottom:100px;width:30px;height:30px;border:1px solid rgba(100,116,139,.45);border-radius:999px;background:#fff;color:#334155;box-shadow:0 2px 8px rgba(15,23,42,.18);cursor:pointer;pointer-events:auto;font-size:15px;line-height:1}.vc-pet-chat-bubble{position:absolute;right:0;bottom:132px;width:286px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px;border:1px solid rgba(100,116,139,.38);border-radius:14px;background:#fff;color:#1e293b;box-shadow:0 8px 22px rgba(15,23,42,.2);font:13px/1.45 system-ui,sans-serif;pointer-events:auto}.vc-pet-chat-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}.vc-pet-chat-close{width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:#64748b;cursor:pointer;font-size:20px;line-height:1}.vc-pet-chat-close:hover{background:#f1f5f9}.vc-pet-chat-messages{max-height:196px;overflow-y:auto;padding:2px 1px}.vc-pet-chat-messages p{margin:0 0 7px;white-space:pre-wrap;overflow-wrap:anywhere}.vc-pet-chat-empty{color:#475569}.vc-pet-chat-message-user{color:#334155}.vc-pet-chat-message-pet{color:#0f766e}.vc-pet-chat-thinking{color:#64748b;font-style:italic}.vc-pet-chat-composer{display:flex;gap:6px;margin-top:8px}.vc-pet-chat-composer input{min-width:0;flex:1;padding:7px 8px;border:1px solid #94a3b8;border-radius:8px;background:#fff;color:#1e293b;font:inherit}.vc-pet-chat-composer button{width:31px;border:0;border-radius:8px;background:#0f766e;color:#fff;cursor:pointer;font:600 16px/1 system-ui}.vc-pet-chat-composer button:disabled,.vc-pet-chat-composer input:disabled{cursor:not-allowed;opacity:.58}@media(prefers-color-scheme:dark){.vc-pet-chat-bubble{background:#1e293b;color:#e2e8f0;border-color:#475569}.vc-pet-chat-toggle{background:#1e293b;color:#f8fafc;border-color:#64748b}.vc-pet-chat-close{color:#cbd5e1}.vc-pet-chat-close:hover{background:#334155}.vc-pet-chat-empty,.vc-pet-chat-thinking{color:#cbd5e1}.vc-pet-chat-message-user{color:#e2e8f0}.vc-pet-chat-message-pet{color:#5eead4}.vc-pet-chat-composer input{background:#0f172a;color:#f8fafc;border-color:#64748b}}@keyframes vc-pet-hop{50%{transform:translateY(-10px) scale(1.02)}}@keyframes vc-pet-tilt{from{transform:rotate(-1deg)}to{transform:rotate(2deg)}}@keyframes vc-pet-breathe{50%{transform:scale(1.012,.988)}}@keyframes vc-pet-bob{50%{transform:translateY(-2px)}}@media(prefers-reduced-motion:reduce){.vc-pet-sprite{animation:none!important}}\n";
      document.head.appendChild(tag);
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
