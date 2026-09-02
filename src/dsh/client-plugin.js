import { createPetOverlay } from '../client/pet-overlay.js';

export const inject = ['slots', 'connection'];

export function apply(ctx) {
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
  tag.textContent = __VC_AI_PET_CSS__;
  document.head.appendChild(tag);
}
