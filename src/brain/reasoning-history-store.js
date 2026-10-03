import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHAT_STAGES = new Set([
  'reply',
  'visual-step',
  'visual-search',
  'visual-summary',
]);

function reasoningText(payload) {
  const message = payload?.choices?.[0]?.message;
  if (typeof message?.reasoning_content === 'string') return message.reasoning_content;
  if (typeof message?.reasoning === 'string') return message.reasoning;
  return '';
}

function copyCalls(calls) {
  return calls
    .filter((call) => typeof call?.text === 'string' && call.text.trim().length > 0)
    .map(({ stage, text }) => ({ stage, text }));
}

export class ReasoningHistoryStore {
  constructor({ sandboxRoot } = {}) {
    if (!sandboxRoot) throw new TypeError('sandboxRoot is required');

    this.filePath = path.join(sandboxRoot, 'runtime', 'reasoning-history.json');
    this.chatTurns = [];
    this.dream = null;
    this.context = new AsyncLocalStorage();
    this.initialization = null;
    this.writeQueue = Promise.resolve();
    this.captureForCallback = (input) => this.capture(input);
  }

  initialize() {
    if (!this.initialization) {
      this.initialization = (async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        let contents;
        try {
          contents = await readFile(this.filePath, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') return;
          throw error;
        }

        try {
          const stored = JSON.parse(contents);
          if (!stored || typeof stored !== 'object') return;

          if (Array.isArray(stored.chatTurns)) {
            this.chatTurns = stored.chatTurns
              .filter((turn) =>
                turn &&
                typeof turn.turnId === 'string' &&
                typeof turn.userText === 'string' &&
                typeof turn.createdAt === 'number' &&
                Array.isArray(turn.calls)
              )
              .slice(-3)
              .map((turn) => ({
                turnId: turn.turnId,
                userText: turn.userText,
                source: turn.source ?? null,
                createdAt: turn.createdAt,
                calls: copyCalls(turn.calls),
              }));
          }

          const dream = stored.dream;
          if (
            dream &&
            typeof dream.createdAt === 'number' &&
            Array.isArray(dream.calls)
          ) {
            this.dream = { createdAt: dream.createdAt, calls: copyCalls(dream.calls) };
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          this.chatTurns = [];
          this.dream = null;
        }
      })();
    }
    return this.initialization;
  }

  async run(turnId, callback, { userText = '', source = null } = {}) {
    const parent = this.context.getStore();
    if (parent?.store === this && parent.turnId === turnId) {
      return callback({ capture: this.captureForCallback });
    }

    await this.initialize();
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new TypeError('turnId must be a non-empty string');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function');
    }

    const trace = { store: this, turnId, calls: [] };
    const result = await this.context.run(trace, () => callback({ capture: this.captureForCallback }));
    if (result?.ok === false) return result;

    this.chatTurns = this.chatTurns.filter((turn) => turn.turnId !== turnId);
    this.chatTurns.push({
      turnId,
      userText: String(userText ?? ''),
      source: source ?? null,
      createdAt: Date.now(),
      calls: copyCalls(trace.calls),
    });
    this.chatTurns = this.chatTurns.slice(-3);
    await this.persist();
    return result;
  }

  capture({ payload, stage } = {}) {
    const trace = this.context.getStore();
    if (trace?.store !== this || !CHAT_STAGES.has(stage)) return;

    const call = { stage, text: reasoningText(payload) };
    trace.calls.push(call);
    return { ...call };
  }

  async getChatHistory() {
    await this.initialize();
    return this.chatTurns.map((turn) => ({
      turnId: turn.turnId,
      userText: turn.userText,
      source: turn.source,
      createdAt: turn.createdAt,
      calls: copyCalls(turn.calls),
    }));
  }

  async getDreamHistory() {
    await this.initialize();
    if (!this.dream) return null;
    return { createdAt: this.dream.createdAt, calls: copyCalls(this.dream.calls) };
  }

  async setDreamReasoning(payload) {
    await this.initialize();
    const text = reasoningText(payload);
    this.dream = {
      createdAt: Date.now(),
      calls: text.trim().length > 0 ? [{ stage: 'dream', text }] : [],
    };
    await this.persist();
    return this.getDreamHistory();
  }

  persist() {
    const content = JSON.stringify({ chatTurns: this.chatTurns, dream: this.dream });
    const temporaryPath = this.filePath + '.tmp';
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await writeFile(temporaryPath, content, 'utf8');
        await rename(temporaryPath, this.filePath);
      });
    return this.writeQueue;
  }
}