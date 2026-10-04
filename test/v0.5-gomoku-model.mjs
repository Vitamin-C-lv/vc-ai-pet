import assert from 'node:assert/strict';
import { decideGomokuMove, reviewGomokuGame } from '../src/brain/gomoku-decision.js';
import { createGomokuSessions } from '../src/remote/gomoku-session.js';
import { LocalBrain } from '../src/brain/local-brain.js';
import { buildPetMessages, PET_VOICE_INSTRUCTION } from '../src/brain/prompt-builder.js';
import '../src/remote/mobile-ui/gomoku-engine.js';

const Engine = globalThis.VcAiPetGomokuEngine;

// Deterministic fake Local Brain responses for tests only; these are not a product move algorithm.

function gameWithHistory() {
  const game = Engine.createGame();
  assert.equal(Engine.play(game, 0, 0), true);
  assert.equal(Engine.play(game, 1, 2), true);
  assert.equal(Engine.play(game, 2, 4), true);
  return game;
}

function modelResponse(content, requestId = 'fake-request') {
  return {
    requestId,
    payload: { choices: [{ message: { content } }] }
  };
}

function fakeClient(contents) {
  const calls = [];
  return {
    calls,
    client: {
      async chat(request) {
        calls.push(request);
        const content = contents.shift();
        if (content instanceof Error) throw content;
        return modelResponse(content, 'fake-' + calls.length);
      }
    }
  };
}

const position = gameWithHistory();
{
  const identity = { name: '李花花', breedZh: '伯恩山犬', birthday: '2026-08-31' };
  const state = { mood: 0.65, energy: 0.55, attachment: 0.9 };
  const rules = [{ level: 'rules', content: '主人可以纠正花花的理解。' }];
  const self = [{ level: 'soul', content: '花花最近觉得，认真听主人说话比急着回答更适合自己。',
    provenance: { source: 'REFLECTION_DERIVED', evidence: 'inferred' } }];
  const { client, calls } = fakeClient([
    JSON.stringify({ row: 8, col: 9, mood: 'focused', speech: '' }),
    JSON.stringify({ summary: '主人形成五连获胜。', mood: 'curious', speech: '', observations: [] }),
  ]);
  const brain = new LocalBrain({ client, memory: {
    stableRulesContext: () => rules,
    currentSelfContext: () => self,
    recall: () => [],
  } });
  await brain.gomokuMove({ game: position, identity, state });
  await brain.gomokuReview({ game: humanWinGame(), identity, state });
  const chatPrompt = buildPetMessages({ identity, state, stableRules: rules, currentSelfContext: self, userText: '陪花花下棋。' })[0].content;
  for (const prompt of [chatPrompt, ...calls.map(call => call.messages[0].content)]) {
    assert.ok(prompt.includes(PET_VOICE_INSTRUCTION), 'chat, move and review share the same pet voice');
    assert.ok(prompt.includes(self[0].content), 'the current self understanding reaches every pet interaction');
    assert.ok(prompt.includes(rules[0].content));
    assert.ok(prompt.includes('精力 55/100'), 'the runtime state reaches the model instead of a fixed game personality');
    assert.ok(prompt.includes('[evidence=inferred]'), 'the pet self understanding keeps its evidence qualifier');
  }
}

const moveCases = [
  {
    response: { row: 8, col: 9, mood: 'focused', speech: '花花先稳住。' },
    expected: { row: 7, col: 8, mood: 'focused', speech: '花花先稳住。' },
  },
  {
    response: { row: 15, col: 15, mood: 'curious', speech: '' },
    expected: { row: 14, col: 14, mood: 'curious', speech: '' },
  },
];
for (const [index, testCase] of moveCases.entries()) {
  const { client, calls } = fakeClient([JSON.stringify(testCase.response)]);
  const decision = await decideGomokuMove(client, position);
  assert.deepEqual(
    { row: decision.row, col: decision.col, mood: decision.mood, speech: decision.speech },
    testCase.expected,
    'model coordinates are converted to board coordinates for answer ' + index
  );
  assert.equal(decision.source, 'local-model');
  assert.equal(decision.requestId, 'fake-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, 'medium');
  assert.equal(calls[0].responseFormat.type, 'json_schema');
  assert.equal(calls[0].responseFormat.json_schema.strict, true);

  const userText = calls[0].messages[1].content;
  const rows = userText.split('\n').filter(line => /^第\d+行：/.test(line));
  assert.equal(rows.length, 15);
  for (const row of rows) assert.equal(row.split('：')[1].trim().split(/\s+/).length, 15);
  assert.ok(userText.includes('黑棋坐标（行,列）：(1,1)、(3,5)'));
  assert.ok(userText.includes('白棋坐标（行,列）：(2,3)'));
  assert.ok(rows[0].includes('黑'));
  assert.ok(rows[1].includes('白'));
}

for (const invalid of [
  JSON.stringify({ row: 1, col: 1, mood: 'confident', speech: '花花看看别处。' }),
  'not json',
]) {
  const { client, calls } = fakeClient([
    invalid,
    JSON.stringify({ row: 15, col: 15, mood: 'happy', speech: '' }),
  ]);
  const decision = await decideGomokuMove(client, position);
  assert.deepEqual({ row: decision.row, col: decision.col, mood: decision.mood, speech: decision.speech },
    { row: 14, col: 14, mood: 'happy', speech: '' });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].messages[2].content.includes('棋盘没有变化'));
}

{
  const invalidOccupied = JSON.stringify({ row: 1, col: 1, mood: 'focused', speech: '' });
  const { client, calls } = fakeClient([invalidOccupied, invalidOccupied]);
  await assert.rejects(
    decideGomokuMove(client, position),
    error => error.code === 'GOMOKU_MODEL_INVALID_MOVE'
  );
  assert.equal(calls.length, 2, 'an invalid model result fails after one correction request');
}

{
  const transportError = new Error('transport failed');
  const { client, calls } = fakeClient([transportError]);
  await assert.rejects(decideGomokuMove(client, position), error => error === transportError);
  assert.equal(calls.length, 1);
}

function humanWinGame() {
  const game = Engine.createGame();
  for (let col = 0; col < 5; col += 1) {
    assert.equal(Engine.play(game, 7, col), true);
    if (col < 4) assert.equal(Engine.play(game, 14, col * 2), true);
  }
  assert.equal(game.winner, 1);
  return game;
}

{
  const reviewGame = humanWinGame();
  const review = {
    summary: '主人沿着一条横线形成五连，花花没能及时挡住。',
    mood: 'disappointed',
    speech: '下次我会早点留意。',
    observations: [
      { kind: 'style', content: '主人这局用横向连子建立了直接威胁。', moveNumbers: [1, 3, 5] },
      { kind: 'lesson', content: '花花第2手没有贴近威胁点。', moveNumbers: [2] },
    ],
  };
  const { client, calls } = fakeClient([JSON.stringify(review)]);
  const result = await reviewGomokuGame(client, reviewGame);
  assert.deepEqual(result, { ...review, requestId: 'fake-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, 'medium');
  assert.equal(calls[0].responseFormat.json_schema.name, 'huahua_gomoku_review');
  const reviewPrompt = calls[0].messages[1].content;
  assert.ok(reviewPrompt.includes('规则已确认的结果：主人黑棋获胜'));
  assert.ok(reviewPrompt.includes('完整棋谱：'));
  assert.ok(reviewPrompt.includes('第1手：主人黑棋(8,1)'));
  assert.ok(reviewPrompt.includes('第9手：主人黑棋(8,5)'));
  for (let moveNumber = 1; moveNumber <= reviewGame.history.length; moveNumber += 1) {
    assert.ok(reviewPrompt.includes(`第${moveNumber}手：`), 'review sees move ' + moveNumber);
  }
}

{
  const reviewGame = humanWinGame();
  const invalidStyleReference = {
    summary: '这局结束了。',
    mood: 'curious',
    speech: '',
    observations: [
      { kind: 'style', content: '主人可能偏好这个位置。', moveNumbers: [2] },
    ],
  };
  const correctedReview = {
    summary: '主人以横向连子赢下本局。',
    mood: 'confident',
    speech: '下次我会早点发现威胁。',
    observations: [
      { kind: 'style', content: '主人这局用横向连子制造了直接威胁。', moveNumbers: [1, 3, 5] },
      { kind: 'lesson', content: '花花第2手没有及时靠近威胁。', moveNumbers: [2] },
    ],
  };
  const { client, calls } = fakeClient([JSON.stringify(invalidStyleReference), JSON.stringify(correctedReview)]);
  const result = await reviewGomokuGame(client, reviewGame);
  assert.deepEqual(result, { ...correctedReview, requestId: 'fake-2' });
  assert.equal(calls.length, 2, 'a white style reference gets one model correction request');
  assert.ok(calls[1].messages[2].content.includes('style只能写主人黑棋'));
  assert.ok(calls[1].messages[2].content.includes('[1,3,5,7,9]'));
}

{
  const reviewGame = humanWinGame();
  const invalidStyleReference = {
    summary: '这局结束了。',
    mood: 'curious',
    speech: '',
    observations: [
      { kind: 'style', content: '主人可能偏好这个位置。', moveNumbers: [2] },
    ],
  };
  const { client, calls } = fakeClient([JSON.stringify(invalidStyleReference), JSON.stringify(invalidStyleReference)]);
  await assert.rejects(reviewGomokuGame(client, reviewGame), error => error.code === 'GOMOKU_MODEL_INVALID_REVIEW');
  assert.equal(calls.length, 2, 'an invalid review is rejected after one model correction request');
}

{
  const reviewGame = humanWinGame();
  const noObservations = { summary: '主人形成五连并赢下本局。', mood: 'happy', speech: '', observations: [] };
  const { client } = fakeClient([JSON.stringify(noObservations)]);
  const result = await reviewGomokuGame(client, reviewGame);
  assert.deepEqual(result.observations, [], 'the adapter preserves the model choosing no fixed review observations');
  assert.equal(result.speech, '');
}

function makeSessions(gomokuMove) {
  const calls = [];
  const petContext = { identity: { name: '李花花' }, state: { energy: 0.55 } };
  const sessions = createGomokuSessions({
    getPetContext: () => petContext,
    getBrain() {
      return {
        async gomokuMove(request) {
          calls.push(request);
          return gomokuMove(request, calls.length);
        }
      };
    }
  });
  return { sessions, calls };
}

{
  let finishModelMove;
  const { sessions, calls } = makeSessions(() => new Promise(resolve => { finishModelMove = resolve; }));
  const started = sessions.start();
  const id = started.game.id;
  const pending = sessions.move(id, 7, 7);
  assert.equal(sessions.get(id).game.modelStatus, 'thinking');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].game.currentPlayer, 2);
  assert.equal(calls[0].game.history.length, 1);
  assert.equal(calls[0].game.board[7][7], 1);
  assert.equal(calls[0].game.history[0].player, 1);
  assert.deepEqual(calls[0].identity, { name: '李花花' });
  assert.deepEqual(calls[0].state, { energy: 0.55 });

  const repeated = await sessions.move(id, 6, 6);
  assert.equal(repeated.error, 'gomoku-move-not-allowed');
  const prematureRetry = await sessions.retry(id);
  assert.equal(prematureRetry.error, 'gomoku-retry-not-allowed');
  const prematureUndo = sessions.undo(id);
  assert.equal(prematureUndo.error, 'gomoku-undo-not-allowed');
  assert.equal(sessions.get(id).game.history.length, 1);

  finishModelMove({ row: 7, col: 8, mood: 'nervous', speech: '花花先挡住这里。' });
  const completed = await pending;
  assert.equal(completed.ok, true);
  assert.equal(completed.game.modelStatus, 'idle');
  assert.equal(completed.game.winner, 0);
  assert.equal(completed.game.history.length, 2);
  assert.equal(completed.game.history[0].player, 1);
  assert.equal(completed.game.history[1].player, 2);
  assert.equal(completed.game.history[1].source, 'local-model');
  assert.equal(completed.game.history[1].mood, 'nervous');
  assert.equal(completed.game.history[1].speech, '花花先挡住这里。');
  assert.equal(completed.game.mood, 'nervous');
  assert.equal(completed.game.speech, '花花先挡住这里。');
  assert.equal(completed.game.currentPlayer, 1);

  const pairUndo = sessions.undo(id);
  assert.equal(pairUndo.ok, true);
  assert.equal(pairUndo.game.history.length, 0);
  assert.equal(pairUndo.game.currentPlayer, 1);
  assert.equal(pairUndo.game.modelStatus, 'idle');
}

{
  let calls = 0;
  const { sessions } = makeSessions(() => {
    calls += 1;
    if (calls === 1) throw new Error('fake model unavailable');
    return { row: 4, col: 4, mood: 'confident', speech: '花花重新看过了。' };
  });
  const { game: started } = sessions.start();
  const failed = await sessions.move(started.id, 7, 7);
  assert.equal(failed.ok, false);
  assert.equal(failed.game.modelStatus, 'failed');
  assert.equal(failed.game.currentPlayer, 2);
  assert.equal(failed.game.history.length, 1);
  assert.equal(failed.game.board[7][7], 1);
  assert.equal(failed.game.winner, 0);

  const retried = await sessions.retry(started.id);
  assert.equal(calls, 2);
  assert.equal(retried.ok, true);
  assert.equal(retried.game.history.length, 2);
  assert.equal(retried.game.history[1].source, 'local-model');
  assert.equal(retried.game.history[1].mood, 'confident');
  assert.equal(retried.game.history[1].speech, '花花重新看过了。');
  assert.equal(retried.game.mood, 'confident');
  assert.equal(retried.game.speech, '花花重新看过了。');
  assert.equal(retried.game.currentPlayer, 1);
  assert.equal(sessions.undo(started.id).game.history.length, 0);
}

{
  const { sessions } = makeSessions(() => { throw new Error('fake model unavailable'); });
  const { game: started } = sessions.start();
  const failed = await sessions.move(started.id, 7, 7);
  assert.equal(failed.game.history.length, 1);
  const singleUndo = sessions.undo(started.id);
  assert.equal(singleUndo.ok, true);
  assert.equal(singleUndo.game.history.length, 0);
  assert.equal(singleUndo.game.board[7][7], 0);
  assert.equal(singleUndo.game.currentPlayer, 1);
}

{
  const whiteMoves = [
    { row: 14, col: 0 },
    { row: 14, col: 2 },
    { row: 14, col: 4 },
    { row: 14, col: 6 }
  ];
  let calls = 0;
  const { sessions } = makeSessions(() => ({ ...whiteMoves[calls++], mood: 'curious', speech: '' }));
  const { game: started } = sessions.start();

  for (let col = 0; col < 4; col += 1) {
    const turn = await sessions.move(started.id, 0, col);
    assert.equal(turn.ok, true);
    assert.equal(turn.game.winner, 0);
  }
  assert.equal(calls, 4);

  const finalTurn = await sessions.move(started.id, 0, 4);
  assert.equal(finalTurn.ok, true);
  assert.equal(finalTurn.game.winner, 1);
  assert.equal(finalTurn.game.currentPlayer, 1);
  assert.equal(finalTurn.game.history.at(-1).player, 1);
  assert.equal(calls, 4, 'a human win does not call the model');
}

{
  const whiteMoves = Array.from({ length: 5 }, function (_, col) { return { row: 0, col: col }; });
  let calls = 0;
  const { sessions } = makeSessions(() => ({ ...whiteMoves[calls++], mood: 'focused', speech: '' }));
  const { game: started } = sessions.start();
  const humanCols = [0, 2, 4, 6, 8];

  for (let col = 0; col < 5; col += 1) {
    const turn = await sessions.move(started.id, 14, humanCols[col]);
    assert.equal(turn.ok, true);
    if (col < 4) assert.equal(turn.game.winner, 0);
    else {
      assert.equal(turn.game.winner, 2);
      assert.equal(turn.game.currentPlayer, 2);
      assert.equal(turn.game.history.at(-1).player, 2);
      assert.equal(turn.game.history.at(-1).source, 'local-model');
    }
  }
  assert.equal(calls, 5);
}

console.log('PASS v0.5 Gomoku model adapter and sessions');
