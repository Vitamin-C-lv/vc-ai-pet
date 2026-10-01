import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReasoningDebugStore } from '../src/brain/reasoning-debug-store.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'vc-ai-pet-reasoning-debug-'));
try {
  const store = new ReasoningDebugStore({ sandboxRoot: root });
  await store.initialize();
  assert.deepEqual(store.getSettings(), { reasoningDebugEnabled: false });

  await store.run('off-turn', ({ capture }) => {
    assert.equal(capture({
      payload: { choices: [{ message: { reasoning_content: 'hidden' } }] }
    }), undefined);
  });
  assert.deepEqual(store.getTrace('off-turn'), { status: 'disabled', calls: [] });
  await assert.rejects(
    readFile(path.join(root, 'runtime', 'reasoning-debug.json'), 'utf8'),
    (error) => error.code === 'ENOENT'
  );

  await store.setEnabled(true);
  assert.equal(store.capture({
    payload: { choices: [{ message: { reasoning_content: 'outside context' } }] }
  }), undefined);

  let started;
  const runningStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const runningGate = new Promise((resolve) => { release = resolve; });
  const runningTurn = store.run('turn-running', async ({ capture }) => {
    capture({
      payload: { choices: [{ message: { reasoning_content: 'visible while running' } }] },
      stage: 'visual-step'
    });
    started();
    await runningGate;
  });
  await runningStarted;
  assert.deepEqual(store.getTrace('turn-running'), {
    turnId: 'turn-running',
    status: 'running',
    calls: [{ index: 1, text: 'visible while running', stage: 'visual-step' }]
  });
  release();
  await runningTurn;
  assert.equal(store.getTrace('turn-running').status, 'complete');

  const result = await store.run('turn-a', async ({ capture }) => {
    capture({
      payload: {
        choices: [{
          message: { reasoning_content: 'first actual trace', content: 'answer text' },
          finish_reason: 'stop'
        }]
      },
      reasoningEffort: 'medium',
      durationMs: 125,
      requestId: 'req-a',
      stage: 'reply'
    });
    await store.run('turn-a', async ({ capture: nestedCapture }) => {
      await Promise.resolve();
      nestedCapture({
        payload: { choices: [{ message: { reasoning: 'second actual trace' } }] },
        stage: 'visual-step'
      });
      return 'nested-result';
    });
    capture({ payload: { choices: [{ message: { content: 'must not be used' } }] } });
    return 'callback-result';
  });
  assert.equal(result, 'callback-result');
  assert.deepEqual(store.getTrace('turn-a'), {
    turnId: 'turn-a',
    status: 'complete',
    calls: [
      {
        index: 1,
        text: 'first actual trace',
        stage: 'reply',
        effort: 'medium',
        durationMs: 125,
        requestId: 'req-a',
        finishReason: 'stop'
      },
      { index: 2, text: 'second actual trace', stage: 'visual-step' },
      { index: 3, text: '' }
    ]
  });

  await Promise.all([
    store.run('parallel-a', async ({ capture }) => {
      await new Promise((resolve) => setTimeout(resolve, 8));
      capture({ payload: { choices: [{ message: { reasoning_content: 'parallel A' } }] } });
    }),
    store.run('parallel-b', async ({ capture }) => {
      await Promise.resolve();
      capture({ payload: { choices: [{ message: { reasoning_content: 'parallel B' } }] } });
    })
  ]);
  assert.equal(store.getTrace('parallel-a').calls[0].text, 'parallel A');
  assert.equal(store.getTrace('parallel-b').calls[0].text, 'parallel B');

  await store.run('no-reasoning', ({ capture }) => {
    capture({
      payload: { choices: [{ message: { content: 'ordinary answer only' } }] },
      stage: 'visual-search'
    });
  });
  assert.deepEqual(store.getTrace('no-reasoning'), {
    turnId: 'no-reasoning',
    status: 'complete',
    calls: [{ index: 1, text: '', stage: 'visual-search' }]
  });

  const modelError = new Error('callback failed');
  await assert.rejects(
    store.run('failed-turn', ({ capture }) => {
      capture({ payload: { choices: [{ message: { reasoning_content: 'captured before failure' } }] } });
      throw modelError;
    }),
    (error) => error === modelError
  );
  assert.equal(store.getTrace('failed-turn').status, 'failed');
  assert.equal(store.getTrace('failed-turn').calls[0].text, 'captured before failure');

  const persisted = JSON.parse(await readFile(path.join(root, 'runtime', 'reasoning-debug.json'), 'utf8'));
  assert.equal(persisted.reasoningDebugEnabled, true);
  assert.equal(persisted.traces.find((trace) => trace.turnId === 'turn-a').calls.length, 3);
  const restarted = new ReasoningDebugStore({ sandboxRoot: root });
  await restarted.initialize();
  assert.deepEqual(restarted.getSettings(), { reasoningDebugEnabled: true });
  assert.equal(restarted.getTrace('turn-a').calls[0].text, 'first actual trace');

  await restarted.setEnabled(false);
  assert.deepEqual(restarted.getTrace('turn-a'), { status: 'disabled', calls: [] });
  const afterDisableRestart = new ReasoningDebugStore({ sandboxRoot: root });
  await afterDisableRestart.initialize();
  assert.deepEqual(afterDisableRestart.getSettings(), { reasoningDebugEnabled: false });

  const offAtStart = new ReasoningDebugStore({ sandboxRoot: root });
  await offAtStart.setEnabled(false);
  let finishOffRun;
  const offRunGate = new Promise((resolve) => { finishOffRun = resolve; });
  let offRunStarted;
  const offStarted = new Promise((resolve) => { offRunStarted = resolve; });
  const offRun = offAtStart.run('off-at-start', async ({ capture }) => {
    offRunStarted();
    await offRunGate;
    capture({ payload: { choices: [{ message: { reasoning_content: 'must remain off' } }] } });
  });
  await offStarted;
  await offAtStart.setEnabled(true);
  finishOffRun();
  await offRun;
  assert.deepEqual(offAtStart.getTrace('off-at-start'), { status: 'unavailable', calls: [] });

  const boundedRoot = await mkdtemp(path.join(os.tmpdir(), 'vc-ai-pet-reasoning-debug-bounded-'));
  try {
    const bounded = new ReasoningDebugStore({ sandboxRoot: boundedRoot, maxTurns: 2 });
    await bounded.setEnabled(true);
    for (const id of ['oldest', 'middle', 'newest']) {
      await bounded.run(id, ({ capture }) => capture({
        payload: { choices: [{ message: { reasoning_content: id } }] }
      }));
    }
    assert.deepEqual(bounded.getTrace('oldest'), { status: 'unavailable', calls: [] });
    assert.equal(bounded.getTrace('middle').calls[0].text, 'middle');
    assert.equal(bounded.getTrace('newest').calls[0].text, 'newest');
  } finally {
    await rm(boundedRoot, { recursive: true, force: true });
  }

  const malformedRoot = await mkdtemp(path.join(os.tmpdir(), 'vc-ai-pet-reasoning-debug-malformed-'));
  try {
    await mkdir(path.join(malformedRoot, 'runtime'));
    await writeFile(path.join(malformedRoot, 'runtime', 'reasoning-debug.json'), '{', 'utf8');
    const recovered = new ReasoningDebugStore({ sandboxRoot: malformedRoot });
    await assert.doesNotReject(recovered.initialize());
    assert.deepEqual(recovered.getSettings(), { reasoningDebugEnabled: false });
  } finally {
    await rm(malformedRoot, { recursive: true, force: true });
  }

  const persistFailure = new ReasoningDebugStore({ sandboxRoot: root });
  await persistFailure.initialize();
  persistFailure.reasoningDebugEnabled = true;
  persistFailure.persist = async () => { throw new Error('optional debug write failed'); };
  assert.equal(await persistFailure.run('write-failure', () => 'normal reply'), 'normal reply');
  assert.deepEqual(persistFailure.getTrace('write-failure'), { turnId: 'write-failure', status: 'complete', calls: [] });
  const primaryError = new Error('model failed');
  await assert.rejects(
    persistFailure.run('write-failure-with-error', () => { throw primaryError; }),
    (error) => error === primaryError
  );
  await assert.rejects(persistFailure.setEnabled(false), /optional debug write failed/);
  assert.equal(persistFailure.getSettings().reasoningDebugEnabled, true, 'failed setting save keeps the previous setting');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('v0.5 reasoning debug store passed');
