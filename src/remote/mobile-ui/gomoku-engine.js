(function (root) {
  'use strict';

  const SIZE = 15;
  const EMPTY = 0;
  const DIRECTIONS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ];

  function createGame() {
    return {
      board: Array.from({ length: SIZE }, function () {
        return Array(SIZE).fill(EMPTY);
      }),
      currentPlayer: 1,
      winner: 0,
      draw: false,
      history: [],
      winningCells: []
    };
  }

  function isWinningFrom(board, row, col, player, direction) {
    const dr = direction[0];
    const dc = direction[1];
    let count = 1;

    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === player) {
        count += 1;
        r += dr * sign;
        c += dc * sign;
      }
    }

    return count >= 5;
  }

  function collectWinningCells(board, row, col, player) {
    const cells = new Map();

    for (const direction of DIRECTIONS) {
      if (!isWinningFrom(board, row, col, player, direction)) continue;

      const dr = direction[0];
      const dc = direction[1];
      let startRow = row;
      let startCol = col;
      let r = row - dr;
      let c = col - dc;

      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === player) {
        startRow = r;
        startCol = c;
        r -= dr;
        c -= dc;
      }

      r = startRow;
      c = startCol;
      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === player) {
        cells.set(r + ',' + c, { row: r, col: c });
        r += dr;
        c += dc;
      }
    }

    return Array.from(cells.values());
  }

  function play(game, row, col) {
    if (!game || game.winner !== 0 || game.draw) return false;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return false;
    if (game.currentPlayer !== 1 && game.currentPlayer !== 2) return false;
    if (game.board[row][col] !== EMPTY) return false;

    const player = game.currentPlayer;
    game.board[row][col] = player;
    game.history.push({ row: row, col: col, player: player });

    const winningCells = collectWinningCells(game.board, row, col, player);
    if (winningCells.length > 0) {
      game.winner = player;
      game.winningCells = winningCells;
      return true;
    }

    if (game.history.length === SIZE * SIZE) {
      game.draw = true;
      return true;
    }

    game.currentPlayer = player === 1 ? 2 : 1;
    return true;
  }

  root.VcAiPetGomokuEngine = {
    SIZE: SIZE,
    createGame: createGame,
    play: play
  };
}(globalThis));
