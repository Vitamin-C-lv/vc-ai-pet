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

    const K='vc-ai-pet:v0.1:client-state';function load(){try{const x=globalThis.localStorage?.getItem(K);if(x)return JSON.parse(x)}catch{}return createInitialState()}function save(v){try{globalThis.localStorage?.setItem(K,JSON.stringify(v))}catch{}}function createPetOverlay({assetBaseUrl,bridge=null}){return function PetOverlay(){const[state,setState]=React.useState(load),[visual,setVisual]=React.useState(()=>chooseVisual(state)),[pos,setPos]=React.useState({x:null,y:null});const drag=React.useRef(null);React.useEffect(()=>{let alive=true;(async()=>{try{const remote=await bridge?.readState?.();if(alive&&remote)setState(remote)}catch{}})();return()=>{alive=false}},[]);React.useEffect(()=>{const id=globalThis.setInterval?.(()=>setState(prev=>{const next=advanceState(prev);save(next);bridge?.writeState?.(next).catch?.(()=>{});setVisual(chooseVisual(next));return next}),10000);return()=>globalThis.clearInterval?.(id)},[]);function act(kind='pet'){setState(prev=>{const next=interact(prev,kind);save(next);bridge?.interact?.(kind).catch?.(()=>{});setVisual(chooseVisual(next,.05));return next})}function down(e){drag.current={px:e.clientX,py:e.clientY,startX:pos.x??0,startY:pos.y??0,moved:false};e.currentTarget.setPointerCapture?.(e.pointerId)}function move(e){if(!drag.current)return;const dx=e.clientX-drag.current.px,dy=e.clientY-drag.current.py;if(Math.abs(dx)+Math.abs(dy)>5)drag.current.moved=true;if(drag.current.moved)setPos({x:drag.current.startX+dx,y:drag.current.startY+dy})}function up(){const moved=drag.current?.moved;drag.current=null;if(!moved)act(state.current==='sleep'?'wake':'pet')}const img=visual==='walk'?`${assetBaseUrl}/walk-right-3.png`:`${assetBaseUrl}/${SPRITES[visual]??SPRITES.idle}`;return React.createElement('div',{className:'vc-pet-overlay-root','data-pet-state':state.current,style:pos.x==null?undefined:{transform:`translate(${pos.x}px,${pos.y}px)`}},React.createElement('button',{className:'vc-pet-hitbox',type:'button',title:'小伯恩山',onPointerDown:down,onPointerMove:move,onPointerUp:up,onDoubleClick:()=>act('play'),'aria-label':'AI pet'},React.createElement('img',{className:`vc-pet-sprite vc-pet-state-${state.current}`,src:img,draggable:false,alt:''})))}}



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
        interact: (kind) => call('interact', { kind })
      };
    }

    function installCss() {
      if (document.querySelector('style[data-vc-ai-pet]')) return;
      const tag = document.createElement('style');
      tag.dataset.vcAiPet = 'v0.1';
      tag.textContent = ".vc-pet-overlay-root{position:fixed;right:24px;bottom:18px;z-index:40;pointer-events:none;user-select:none;contain:layout paint style}.vc-pet-hitbox{width:126px;height:126px;padding:0;border:0;background:transparent;cursor:grab;pointer-events:auto;touch-action:none}.vc-pet-hitbox:active{cursor:grabbing}.vc-pet-sprite{width:126px;height:126px;object-fit:contain;image-rendering:pixelated;pointer-events:none;filter:drop-shadow(0 5px 7px rgba(0,0,0,.16));transform-origin:50% 100%}.vc-pet-state-happy{animation:vc-pet-hop .35s ease-out 1}.vc-pet-state-curious{animation:vc-pet-tilt 1.8s ease-in-out infinite alternate}.vc-pet-state-sleep{animation:vc-pet-breathe 2.8s ease-in-out infinite}.vc-pet-state-walk{animation:vc-pet-bob .42s steps(2,end) infinite}@keyframes vc-pet-hop{50%{transform:translateY(-10px) scale(1.02)}}@keyframes vc-pet-tilt{from{transform:rotate(-1deg)}to{transform:rotate(2deg)}}@keyframes vc-pet-breathe{50%{transform:scale(1.012,.988)}}@keyframes vc-pet-bob{50%{transform:translateY(-2px)}}@media(prefers-reduced-motion:reduce){.vc-pet-sprite{animation:none!important}}\n";
      document.head.appendChild(tag);
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
