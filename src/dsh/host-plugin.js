import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { PetRuntime } from '../runtime/pet-runtime.js';
import { normalizePetVisualConfig } from '../client/pet-visual-state.js';
import { startLanServer } from '../remote/lan-server.js';
import { normalizeVisionImage } from '../brain/vision-input.js';

export const name = 'vc-ai-pet';
export const inject = ['connection'];

const DEFAULT_SANDBOX = join(homedir(), '.local', 'share', 'vc-ai-pet', 'sandbox');
const DEFAULT_ASSETS = resolve(new URL('../../assets/runtime/', import.meta.url).pathname);
const ASSETS = new Set([
  'avatar.png', 'beg.png', 'bark.png', 'blink-happy.png', 'curious.png',
  'icon-paw.png', 'idle-3q.png', 'idle-front.png', 'interaction-sheet.png',
  'jump.png', 'playbow.png', 'rest-awake.png', 'rest-curled.png', 'sit.png',
  'sleep-curled.png', 'sleep-side.png', 'sleepy-sit.png', 'stretch.png',
  'surprised.png', 'toy-ball.png', 'toy-bone.png', 'toy-food-bowl.png',
  'walk-left-idle.png', 'walk-right-1.png', 'walk-right-2.png',
  'walk-right-3.png', 'walk-right-4.png', 'walk-right-5.png',
  'walk-right-6.png', 'walk-right-strip.png'
]);

export function apply(ctx, rawConfig = {}) {
  const sandboxRoot = resolve(rawConfig.sandboxRoot || DEFAULT_SANDBOX);
  const assetRoot = resolve(rawConfig.assetRoot || DEFAULT_ASSETS);
  const tickMs = Number.isFinite(rawConfig.tickMs) ? Math.max(1_000, rawConfig.tickMs) : 10_000;
  const visualConfig = normalizePetVisualConfig(rawConfig?.petVisual);
  const runtime = new PetRuntime({ sandboxRoot });
  const ready = runtime.initialize();
  const lanEnabled = rawConfig.lanUi?.enabled !== false;
  const lanPort = Number.isInteger(rawConfig.lanUi?.port) ? rawConfig.lanUi.port : 17870;
  const lanServer = lanEnabled
    ? ready.then(() => startLanServer({ runtime, assetRoot, visualConfig, port: lanPort, logger: ctx.logger }))
    : Promise.resolve(null);
  lanServer.catch((error) => ctx.logger.warn(`vc-ai-pet: LAN UI failed to start: ${error.message}`));
  const tick = setInterval(() => {
    void ready.then(() => runtime.tick()).catch((error) => ctx.logger.warn(`vc-ai-pet: tick failed: ${error.message}`));
  }, tickMs);
  tick.unref?.();

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.handle(
      '/vc-ai-pet',
      async (endpoint, payload) => invoke(runtime, ready, endpoint, payload, ctx.logger, visualConfig),
      { authority: 'trusted-host' }
    );
  });

  registerAssetRoute(ctx, assetRoot);
  ctx.effect(() => () => {
    clearInterval(tick);
    void lanServer.then((server) => server?.close());
    runtime.close();
  }, 'vc-ai-pet: runtime cleanup');
  ctx.logger.info(`vc-ai-pet: active (sandbox=${sandboxRoot}, model=on-demand)`);
}

async function invoke(runtime, ready, method, payload, logger, visualConfig) {
  await ready;
  const args = payload?.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return failure('invalid request');
  if (method === 'readState' && Object.keys(args).length === 0) return success(runtime.snapshot());
  if (method === 'readPresence' && Object.keys(args).length === 0) {
    return success({ ...runtime.presenceSnapshot(), ...runtime.presentationSnapshot(visualConfig), visualConfig });
  }
  if (method === 'interact' && Object.keys(args).length === 1 && typeof args.kind === 'string' && ['pet', 'play', 'wake', 'long-press'].includes(args.kind)) {
    return success(await runtime.interact(args.kind));
  }
  if (method === 'chat' && typeof args.userText === 'string' && Object.keys(args).every((key) => ['userText', 'image'].includes(key))) {
    const text = args.userText.trim();
    let image = null;
    try {
      image = normalizeVisionImage(args.image);
    } catch {
      return failure('invalid request');
    }
    if ((text.length < 1 && !image) || text.length > 500) return failure('invalid request');
    try {
      return success(await runtime.chat(text, image));
    } catch {
      logger?.warn?.('vc-ai-pet: local brain request failed');
      return success({ ok: false, unavailable: false, reason: 'local-brain-error', petLine: '花花脑袋刚刚卡了一下……' });
    }
  }
  return failure('invalid request');
}

function registerAssetRoute(ctx, assetRoot) {
  const webServer = ctx.get?.('webServer');
  if (!webServer?.register) return;
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/vc-ai-pet/assets',
    handler: async (req, res) => {
      const path = new URL(req.url || '/', 'http://local').pathname;
      const filename = basename(decodeURIComponent(path));
      if (!ASSETS.has(filename)) return notFound(res);
      try {
        const bytes = await readFile(join(assetRoot, filename));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' });
        res.end(bytes);
      } catch {
        notFound(res);
      }
    }
  }));
}

function success(value) { return { ok: true, value }; }
function failure(message) { return { ok: false, error: { code: 'invalid-request', message } }; }
function notFound(res) { res.writeHead(404); res.end(); }

export default { name, inject, apply };
