import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../src/remote/mobile-ui/gomoku-engine.js';

const Engine = globalThis.VcAiPetGomokuEngine;
assert.equal(Engine.SIZE, 15);

const browserScript = await readFile(new URL('../src/remote/mobile-ui/gomoku-engine.js', import.meta.url), 'utf8');
const browserContext = {};
vm.runInNewContext(browserScript, browserContext);
assert.equal(browserContext.VcAiPetGomokuEngine.SIZE, 15);
assert.deepEqual(
  Object.keys(browserContext.VcAiPetGomokuEngine.createGame()),
  ['board', 'currentPlayer', 'winner', 'draw', 'history', 'winningCells']
);

function playLine(direction, startRow, startCol) {
  const game = Engine.createGame();
  const fillers = direction === 'vertical'
    ? Array.from({ length: 4 }, function (_, i) { return { row: i, col: 14 }; })
    : Array.from({ length: 4 }, function (_, i) { return { row: 14 - i, col: 14 }; });
  const target = [];

  for (let i = 0; i < 5; i += 1) {
    const row = startRow + (direction === 'vertical' ? i : direction === 'diagonal' ? i : direction === 'anti-diagonal' ? i : 0);
    const col = startCol + (direction === 'horizontal' ? i : direction === 'diagonal' ? i : direction === 'anti-diagonal' ? -i : 0);
    target.push({ row: row, col: col });
  }

  for (let i = 0; i < target.length; i += 1) {
    assert.equal(Engine.play(game, target[i].row, target[i].col), true);
    if (i < fillers.length) assert.equal(Engine.play(game, fillers[i].row, fillers[i].col), true);
  }

  assert.equal(game.winner, 1, direction + ' win');
  assert.equal(game.draw, false);
  assert.equal(game.winningCells.length, 5);
  assert.equal(game.currentPlayer, 1);
  return game;
}

playLine('horizontal', 0, 0);
playLine('vertical', 0, 0);
playLine('diagonal', 0, 0);
playLine('anti-diagonal', 0, 14);

const overline = Engine.createGame();
for (const col of [4, 5, 7, 8, 9]) {
  assert.equal(Engine.play(overline, 7, col), true);
  assert.equal(Engine.play(overline, 0, col - 4), true);
}
assert.equal(Engine.play(overline, 7, 6), true);
assert.equal(overline.winner, 1);
assert.equal(overline.winningCells.length, 6);

const legal = Engine.createGame();
assert.equal(Engine.play(legal, 7, 7), true);
assert.equal(Engine.play(legal, 7, 7), false);
assert.equal(Engine.play(legal, -1, 7), false);
assert.equal(Engine.play(legal, 15, 7), false);
assert.equal(Engine.play(legal, 1.5, 7), false);
assert.equal(legal.currentPlayer, 2);
assert.equal(legal.history.length, 1);
assert.equal(legal.board[7][7], 1);

const finished = playLine('horizontal', 0, 0);
assert.equal(Engine.play(finished, 5, 5), false);
assert.equal(finished.history.length, 9);

const draw = Engine.createGame();
const cells = { 1: [], 2: [] };
for (let row = 0; row < Engine.SIZE; row += 1) {
  for (let col = 0; col < Engine.SIZE; col += 1) {
    const firstPlayer = row % 2 === Math.floor(col / 2) % 2;
    cells[firstPlayer ? 1 : 2].push({ row: row, col: col });
  }
}
assert.equal(cells[1].length, 113);
assert.equal(cells[2].length, 112);

for (let move = 0; move < Engine.SIZE * Engine.SIZE; move += 1) {
  const player = move % 2 === 0 ? 1 : 2;
  const cell = cells[player].shift();
  assert.ok(cell, 'fixture has a cell for player ' + player);
  assert.equal(Engine.play(draw, cell.row, cell.col), true);
  if (move < Engine.SIZE * Engine.SIZE - 1) assert.equal(draw.winner, 0);
}
assert.equal(draw.winner, 0);
assert.equal(draw.draw, true);
assert.equal(draw.history.length, Engine.SIZE * Engine.SIZE);
assert.equal(Engine.play(draw, 0, 0), false);

console.log('PASS v0.5 Gomoku rules');
