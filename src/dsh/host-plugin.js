import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { PetRuntime } from '../runtime/pet-runtime.js';

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
  const runtime = new PetRuntime({ sandboxRoot });
  const ready = runtime.initialize();
  const tick = setInterval(() => {
    void ready.then(() => runtime.tick()).catch((error) => ctx.logger.warn(`vc-ai-pet: tick failed: ${error.message}`));
  }, tickMs);
  tick.unref?.();

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.intercept(
      '/vc-ai-pet',
      (method) => method === 'readState' || method === 'interact',
      async (method, payload) => invoke(runtime, ready, method, payload),
      { authority: 'trusted-host' }
    );
  });

  registerAssetRoute(ctx, assetRoot);
  ctx.effect(() => () => {
    clearInterval(tick);
    runtime.close();
  }, 'vc-ai-pet: runtime cleanup');
  ctx.logger.info(`vc-ai-pet: active (sandbox=${sandboxRoot}, model=disabled)`);
}

async function invoke(runtime, ready, method, payload) {
  await ready;
  const args = payload?.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return failure('invalid request');
  if (method === 'readState' && Object.keys(args).length === 0) return success(runtime.snapshot());
  if (method === 'interact' && Object.keys(args).length === 1 && typeof args.kind === 'string' && ['pet', 'play', 'wake'].includes(args.kind)) {
    return success(await runtime.interact(args.kind));
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
