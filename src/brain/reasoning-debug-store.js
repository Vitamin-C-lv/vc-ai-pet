import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ReasoningDebugStore {
  constructor({ sandboxRoot, maxTurns = 32 } = {}) {
    if (!sandboxRoot) throw new TypeError('sandboxRoot is required');
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new TypeError('maxTurns must be a positive integer');
    }

    this.filePath = path.join(sandboxRoot, 'runtime', 'reasoning-debug.json');
    this.maxTurns = maxTurns;
    this.reasoningDebugEnabled = false;
    this.traces = [];
    this.activeTraces = new Map();
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
          if (
            !stored ||
            typeof stored !== 'object' ||
            typeof stored.reasoningDebugEnabled !== 'boolean' ||
            !Array.isArray(stored.traces)
          ) {
            return;
          }
          this.reasoningDebugEnabled = stored.reasoningDebugEnabled;
          this.traces = stored.traces
            .filter((trace) =>
              trace &&
              typeof trace.turnId === 'string' &&
              (trace.status === 'complete' || trace.status === 'failed') &&
              Array.isArray(trace.calls)
            )
            .slice(-this.maxTurns);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          this.reasoningDebugEnabled = false;
          this.traces = [];
        }
      })();
    }
    return this.initialization;
  }

  getSettings() {
    return { reasoningDebugEnabled: this.reasoningDebugEnabled };
  }

  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean');
    }
    await this.initialize();
    const previous = this.reasoningDebugEnabled;
    this.reasoningDebugEnabled = enabled;
    try {
      await this.persist();
    } catch (error) {
      this.reasoningDebugEnabled = previous;
      throw error;
    }
    return this.getSettings();
  }

  async run(turnId, callback) {
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
    if (!this.reasoningDebugEnabled) {
      return callback({ capture: this.captureForCallback });
    }

    const trace = { store: this, turnId, status: 'running', calls: [] };
    this.activeTraces.set(turnId, trace);
    try {
      const result = await this.context.run(trace, () => callback({ capture: this.captureForCallback }));
      trace.status = 'complete';
      return result;
    } catch (error) {
      trace.status = 'failed';
      throw error;
    } finally {
      if (this.activeTraces.get(turnId) === trace) this.activeTraces.delete(turnId);
      const { turnId: id, status, calls } = trace;
      this.traces = this.traces.filter((item) => item.turnId !== id);
      this.traces.push({ turnId: id, status, calls });
      this.traces = this.traces.slice(-this.maxTurns);
      try {
        await this.persist();
      } catch {
        // Optional debug persistence must not change the model result.
      }
    }
  }

  capture({ payload, reasoningEffort, durationMs, requestId, stage } = {}) {
    if (!this.reasoningDebugEnabled) return;
    const trace = this.context.getStore();
    if (trace?.store !== this) return;

    const choice = payload?.choices?.[0];
    const message = choice?.message;
    const text = typeof message?.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message?.reasoning === 'string'
        ? message.reasoning
        : '';

    const call = { index: trace.calls.length + 1, text };
    if (typeof stage === 'string') call.stage = stage;
    if (typeof reasoningEffort === 'string') call.effort = reasoningEffort;
    if (typeof durationMs === 'number') call.durationMs = durationMs;
    if (typeof requestId === 'string') call.requestId = requestId;
    if (typeof choice?.finish_reason === 'string') call.finishReason = choice.finish_reason;
    trace.calls.push(call);
    return { ...call };
  }

  getTrace(turnId) {
    if (!this.reasoningDebugEnabled) return { status: 'disabled', calls: [] };
    const trace = this.activeTraces.get(turnId) ||
      [...this.traces].reverse().find((item) => item.turnId === turnId);
    if (!trace) return { status: 'unavailable', calls: [] };
    const calls = trace.calls.map((call) => ({ ...call }));
    if (trace.status === 'running') {
      return { turnId, status: 'running', calls };
    }
    return { turnId: trace.turnId, status: trace.status, calls };
  }

  persist() {
    const content = JSON.stringify({
      reasoningDebugEnabled: this.reasoningDebugEnabled,
      traces: this.traces
    });
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
