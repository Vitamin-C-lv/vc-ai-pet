(function installVcAiPetGomoku(global) {
  const SIZE = 15
  const START_URL = '/api/pet/gomoku/start'
  const SESSION_KEY = 'vc-ai-pet-gomoku-game-id'
  const MOOD_LABELS = Object.freeze({
    focused: '专注',
    confident: '有把握',
    nervous: '紧张',
    happy: '开心',
    disappointed: '失落',
    curious: '好奇',
  })

  function createGomokuController({ root } = {}) {
    const canvas = root.querySelector('#gomoku-board')
    const context = canvas.getContext('2d')
    const status = root.querySelector('#gomoku-status')
    const lastMove = root.querySelector('#gomoku-last-move')
    const petTurn = root.querySelector('#gomoku-pet-turn')
    const mood = root.querySelector('#gomoku-mood')
    const speech = root.querySelector('#gomoku-speech')
    const gamePanel = root.querySelector('#gomoku-game-panel')
    const historyPanel = root.querySelector('#gomoku-history-panel')
    const historyStatus = root.querySelector('#gomoku-history-status')
    const historyList = root.querySelector('#gomoku-history-list')
    const historyMoreButton = root.querySelector('#gomoku-history-more')
    const playButton = root.querySelector('#gomoku-play')
    const undoButton = root.querySelector('#gomoku-undo')
    const restartButton = root.querySelector('#gomoku-restart')
    const retryButton = root.querySelector('#gomoku-retry')
    const historyOpenButton = root.querySelector('#gomoku-history-open')
    const historyBackButton = root.querySelector('#gomoku-history-back')
    const replayControls = root.querySelector('#gomoku-replay-controls')
    const replayPosition = root.querySelector('#gomoku-replay-position')
    const replayFirstButton = root.querySelector('#gomoku-replay-first')
    const replayPrevButton = root.querySelector('#gomoku-replay-prev')
    const replayNextButton = root.querySelector('#gomoku-replay-next')
    const replayLastButton = root.querySelector('#gomoku-replay-last')
    const replayHistoryButton = root.querySelector('#gomoku-replay-history')
    const replayLiveButton = root.querySelector('#gomoku-replay-live')
    const reviewCard = root.querySelector('#gomoku-review-card')
    const reviewSummary = root.querySelector('#gomoku-review-summary')
    const reviewObservations = root.querySelector('#gomoku-review-observations')
    const reviewMemoryStatus = root.querySelector('#gomoku-memory-status')
    const reviewStartButton = root.querySelector('#gomoku-review-start')

    let active = false
    let liveGame = null
    let game = null
    let gameId = global.sessionStorage?.getItem(SESSION_KEY) || null
    let selected = null
    let cursor = { row: 7, col: 7 }
    let pendingHumanMove = null
    let operation = null
    let operationSequence = 0
    let failure = ''
    let notice = ''
    let recovery = 'sync'
    let pollTimer = null
    let historyRecords = []
    let historyLoading = false
    let historyOffset = 0
    let historyHasMore = false
    let historyError = ''
    let historyVisible = false
    let archiveMode = false
    let archiveLoading = false
    let archiveError = ''
    let replayStep = 0
    let reviewBusy = false
    let reviewTargetId = null
    let reviewError = ''
    let lastSpeechKey = ''

    function rememberGameId(id) {
      if (!id) return
      gameId = String(id)
      global.sessionStorage?.setItem(SESSION_KEY, gameId)
    }

    function clearRememberedGame() {
      gameId = null
      global.sessionStorage?.removeItem(SESSION_KEY)
    }

    function ownsOperation(token) {
      return operation?.token === token
    }

    function setOperation(kind, targetId = null) {
      const token = ++operationSequence
      operation = { kind, targetId, token }
      selected = null
      notice = ''
      failure = ''
      render()
      return token
    }

    function applyLiveGame(nextGame) {
      if (!nextGame) return
      liveGame = nextGame
      rememberGameId(nextGame.id)
      if (!archiveMode) game = nextGame
      if (pendingHumanMove) {
        if (pendingHumanMove.gameId !== nextGame.id) {
          pendingHumanMove = null
        } else if (nextGame.board?.[pendingHumanMove.row]?.[pendingHumanMove.col] === 1) {
          pendingHumanMove = null
          notice = ''
        } else if (nextGame.modelStatus !== 'thinking') {
          pendingHumanMove = null
          notice = '这一步没有送达，请重新选一个交叉点。'
        }
      }
    }

    function applyArchiveGame(nextGame) {
      if (!nextGame) return
      game = nextGame
      archiveMode = true
      replayStep = nextGame.history?.length || 0
      archiveError = ''
      reviewError = ''
      selected = null
    }

    async function requestJson(method, url, body) {
      const options = { method, headers: { Accept: 'application/json' } }
      if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      const response = await global.fetch(url, options)
      return { response, payload: await response.json() }
    }

    function operationCopy() {
      if (operation?.kind === 'move' || operation?.kind === 'retry') return '花花正在看棋盘…'
      if (operation?.kind === 'undo') return '正在悄悄收回上一回合…'
      if (operation?.kind === 'start') return '正在准备新的棋盘…'
      return '正在同步棋局…'
    }

    function displayedHistory() {
      const history = game?.history || []
      return archiveMode ? history.slice(0, replayStep) : history
    }

    function displayedFinal() {
      if (!game || !(game.winner || game.draw)) return false
      return !archiveMode || replayStep >= (game.history?.length || 0)
    }

    function gameResultCopy() {
      if (game?.winner === 1) return '你赢啦！黑棋连成五子。'
      if (game?.winner === 2) return '花花赢啦！白棋连成五子。'
      if (game?.draw) return '棋盘下满了，这一局平局。'
      return ''
    }

    function statusCopy() {
      if (historyVisible) return ''
      if (archiveMode) {
        if (archiveLoading) return '正在打开这局棋…'
        if (archiveError) return archiveError
        if (reviewBusy && reviewTargetId === game?.id) return '花花正在复盘这局棋…'
        if (replayStep < (game?.history?.length || 0)) {
          const move = game.history[replayStep - 1]
          const name = move?.player === 1 ? '主人' : '花花'
          return '回放第 ' + replayStep + ' 手 · ' + name
        }
        return gameResultCopy() || '这局棋的最后一步。'
      }
      if (operation) return operationCopy()
      if (reviewBusy && reviewTargetId === game?.id) return '花花正在复盘这局棋…'
      if (failure) return failure
      if (!game) return active ? '正在连接花花的本地棋局…' : '棋盘准备好了。'
      if (gameResultCopy()) return gameResultCopy()
      if (game.modelStatus === 'failed') return '花花刚才没能完成这一步，可以再试一次。'
      if (game.modelStatus === 'thinking' || pendingHumanMove || game.currentPlayer === 2) return '花花正在看棋盘…'
      if (notice) return notice
      if (selected) return '已选第 ' + (selected.row + 1) + ' 行、第 ' + (selected.col + 1) + ' 列，请确认落子。'
      return '轮到你了，选一个交叉点。'
    }

    function currentPetState() {
      if (!game) return null
      const visibleMoves = displayedHistory()
      if (archiveMode) {
        if (displayedFinal() && game.review) {
          return {
            mood: typeof game.review.mood === 'string' ? game.review.mood : game.mood,
            speech: typeof game.review.speech === 'string' ? game.review.speech : game.speech,
          }
        }
        const move = visibleMoves.length ? visibleMoves[visibleMoves.length - 1] : null
        return move?.player === 2 ? move : null
      }
      if (game.mood || game.speech) return game
      for (let index = visibleMoves.length - 1; index >= 0; index -= 1) {
        if (visibleMoves[index].player === 2) return visibleMoves[index]
      }
      return null
    }

    function isThinking() {
      if (reviewBusy && reviewTargetId === game?.id) return true
      return Boolean(
        operation?.kind === 'move'
        || operation?.kind === 'retry'
        || pendingHumanMove
        || game?.modelStatus === 'thinking'
      )
    }

    function canChooseMove() {
      return Boolean(
        !archiveMode
        && !historyVisible
        && liveGame
        && !liveGame.winner
        && !liveGame.draw
        && liveGame.currentPlayer === 1
        && liveGame.modelStatus !== 'thinking'
        && liveGame.modelStatus !== 'failed'
        && !operation
        && !pendingHumanMove
        && !failure
      )
    }

    function linePoint(row, col, width) {
      const padding = Math.max(16, Math.round(width * 0.045))
      const gap = (width - padding * 2) / (SIZE - 1)
      return { x: padding + col * gap, y: padding + row * gap, gap }
    }

    function drawStone(row, col, player, width, gap) {
      const point = linePoint(row, col, width)
      const radius = gap * 0.39
      const gradient = context.createRadialGradient(
        point.x - radius * 0.28,
        point.y - radius * 0.32,
        radius * 0.08,
        point.x,
        point.y,
        radius,
      )
      if (player === 1) {
        gradient.addColorStop(0, '#5b514a')
        gradient.addColorStop(1, '#251f1b')
      } else {
        gradient.addColorStop(0, '#fffefa')
        gradient.addColorStop(1, '#ded5c9')
      }
      context.beginPath()
      context.arc(point.x, point.y, radius, 0, Math.PI * 2)
      context.fillStyle = gradient
      context.fill()
      context.lineWidth = Math.max(0.7, gap * 0.035)
      context.strokeStyle = player === 1 ? 'rgba(34, 27, 23, .55)' : 'rgba(126, 103, 82, .62)'
      context.stroke()
    }

    function boardForDisplay() {
      const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0))
      if (!game) return board
      if (!archiveMode && game.board) return game.board
      for (const move of displayedHistory()) board[move.row][move.col] = move.player
      return board
    }

    function winningCellsForDisplay() {
      return displayedFinal() ? (game?.winningCells || []) : []
    }

    function drawBoard() {
      const width = canvas.clientWidth
      if (!width) return
      const ratio = global.devicePixelRatio || 1
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(width * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, width)
      context.fillStyle = '#e9c99f'
      context.fillRect(0, 0, width, width)

      const padding = Math.max(16, Math.round(width * 0.045))
      const gap = (width - padding * 2) / (SIZE - 1)
      context.strokeStyle = 'rgba(105, 76, 51, .78)'
      context.lineWidth = Math.max(0.75, width / 550)
      for (let index = 0; index < SIZE; index += 1) {
        const offset = padding + index * gap
        context.beginPath()
        context.moveTo(padding, offset)
        context.lineTo(width - padding, offset)
        context.stroke()
        context.beginPath()
        context.moveTo(offset, padding)
        context.lineTo(offset, width - padding)
        context.stroke()
      }

      for (const row of [3, 7, 11]) {
        for (const col of [3, 7, 11]) {
          const point = linePoint(row, col, width)
          context.beginPath()
          context.arc(point.x, point.y, Math.max(1.5, gap * 0.09), 0, Math.PI * 2)
          context.fillStyle = '#795936'
          context.fill()
        }
      }

      const winningCells = winningCellsForDisplay()
      if (winningCells.length > 1) {
        const first = linePoint(winningCells[0].row, winningCells[0].col, width)
        const last = linePoint(winningCells[winningCells.length - 1].row, winningCells[winningCells.length - 1].col, width)
        const dx = last.x - first.x
        const dy = last.y - first.y
        const length = Math.hypot(dx, dy) || 1
        const extendX = (dx / length) * gap * 0.48
        const extendY = (dy / length) * gap * 0.48
        context.beginPath()
        context.moveTo(first.x - extendX, first.y - extendY)
        context.lineTo(last.x + extendX, last.y + extendY)
        context.strokeStyle = '#c45f43'
        context.lineWidth = Math.max(3, gap * 0.16)
        context.lineCap = 'round'
        context.stroke()
      }

      const board = boardForDisplay()
      for (let row = 0; row < SIZE; row += 1) {
        for (let col = 0; col < SIZE; col += 1) {
          const player = board[row]?.[col] || 0
          if (player) drawStone(row, col, player, width, gap)
        }
      }

      const moves = displayedHistory()
      const last = moves.length ? moves[moves.length - 1] : null
      if (last) {
        const point = linePoint(last.row, last.col, width)
        context.beginPath()
        context.arc(point.x, point.y, gap * 0.49, 0, Math.PI * 2)
        context.strokeStyle = '#b64f37'
        context.lineWidth = Math.max(1.4, gap * 0.075)
        context.stroke()
      }

      if (pendingHumanMove && !archiveMode && pendingHumanMove.gameId === liveGame?.id
        && liveGame?.board?.[pendingHumanMove.row]?.[pendingHumanMove.col] !== 1) {
        drawStone(pendingHumanMove.row, pendingHumanMove.col, 1, width, gap)
        const point = linePoint(pendingHumanMove.row, pendingHumanMove.col, width)
        context.beginPath()
        context.arc(point.x, point.y, gap * 0.49, 0, Math.PI * 2)
        context.strokeStyle = '#be7754'
        context.lineWidth = Math.max(1.3, gap * 0.07)
        context.setLineDash([gap * 0.11, gap * 0.09])
        context.stroke()
        context.setLineDash([])
      }

      if (selected && !archiveMode) {
        const point = linePoint(selected.row, selected.col, width)
        context.beginPath()
        context.arc(point.x, point.y, gap * 0.43, 0, Math.PI * 2)
        context.strokeStyle = '#b55238'
        context.lineWidth = Math.max(1.6, gap * 0.085)
        context.setLineDash([gap * 0.13, gap * 0.09])
        context.stroke()
        context.setLineDash([])
      }
    }

    function moodForDisplay() {
      const state = currentPetState()
      return state?.mood ? (MOOD_LABELS[state.mood] || '') : ''
    }

    function speechForDisplay() {
      const state = currentPetState()
      return typeof state?.speech === 'string' ? state.speech.trim() : ''
    }

    function speechKeyForDisplay(words) {
      if (!words || !game) return ''
      const gameKey = String(game.id || 'current')
      if (displayedFinal() && typeof game.review?.speech === 'string' && game.review.speech.trim() === words) {
        return gameKey + ':review:' + words
      }
      const moves = displayedHistory()
      for (let index = moves.length - 1; index >= 0; index -= 1) {
        const move = moves[index]
        if (move.player === 2 && typeof move.speech === 'string' && move.speech.trim() === words) {
          return gameKey + ':move:' + (index + 1) + ':' + words
        }
      }
      return gameKey + ':turn:' + moves.length + ':' + words
    }

    function renderSpeech(words, key) {
      if (!words) {
        speech.textContent = ''
        speech.hidden = true
        return
      }
      speech.hidden = false
      speech.textContent = words
      if (key === lastSpeechKey) return
      lastSpeechKey = key
      speech.classList.remove('gomoku-speech-enter')
      void speech.offsetWidth
      speech.classList.add('gomoku-speech-enter')
    }

    function renderPetTurn() {
      const thinking = isThinking()
      const moves = displayedHistory()
      const last = moves.length ? moves[moves.length - 1] : null
      petTurn.dataset.thinking = thinking ? 'true' : 'false'
      if (thinking) {
        const reviewing = reviewBusy && reviewTargetId === game?.id
        mood.textContent = reviewing ? '复盘中' : '思考中'
        renderSpeech('', '')
        return
      }
      if (!archiveMode && game?.modelStatus === 'failed') {
        mood.textContent = '思考未完成'
        renderSpeech('', '')
        return
      }
      if (archiveMode && !last) {
        mood.textContent = '开局'
        renderSpeech('', '')
        return
      }
      if (archiveMode && last?.player === 1) {
        mood.textContent = '主人落子'
        renderSpeech('', '')
        return
      }
      mood.textContent = moodForDisplay() || (game ? '等待花花' : '等待落子')
      const words = speechForDisplay()
      renderSpeech(words, speechKeyForDisplay(words))
    }

    function renderLastMove() {
      const moves = displayedHistory()
      if (pendingHumanMove && !archiveMode && pendingHumanMove.gameId === liveGame?.id) {
        lastMove.textContent = '刚刚落下：主人，第 ' + (pendingHumanMove.row + 1) + ' 行第 ' + (pendingHumanMove.col + 1) + ' 列'
      } else if (!moves.length) {
        lastMove.textContent = '还没有落子'
      } else {
        const move = moves[moves.length - 1]
        const playerName = move.player === 1 ? '主人' : '花花'
        lastMove.textContent = '最后一手：' + playerName + '，第 ' + (move.row + 1) + ' 行第 ' + (move.col + 1) + ' 列'
      }
    }

    function isReviewReady() {
      return Boolean(game?.review && (game.review.summary || game.review.observations?.length))
    }

    function renderReview() {
      const atFinishedEnd = displayedFinal()
      reviewCard.hidden = !atFinishedEnd
      if (!atFinishedEnd) return
      const review = game?.review
      const ready = isReviewReady()
      reviewSummary.textContent = ready
        ? (review.summary || '')
        : (reviewError || '这一局还没有复盘。')
      if (review?.memoryStatus === 'saved') reviewMemoryStatus.textContent = '已记入花花的理解'
      else if (review?.memoryStatus === 'failed') reviewMemoryStatus.textContent = '这次没有记入记忆'
      else if (review?.memoryStatus === 'unavailable') reviewMemoryStatus.textContent = '本地记忆暂不可用'
      else reviewMemoryStatus.textContent = ''
      reviewObservations.replaceChildren()
      for (const item of review?.observations || []) {
        const card = document.createElement('div')
        card.className = 'gomoku-review-observation'
        const label = document.createElement('strong')
        label.textContent = item.kind === 'style' ? '出招风格' : '这一局学到的'
        const content = document.createElement('span')
        const turns = item.moveNumbers?.length ? '第 ' + item.moveNumbers.join('、') + ' 手 · ' : ''
        content.textContent = turns + item.content
        card.append(label, content)
        reviewObservations.append(card)
      }
      const memorySaved = review?.memoryStatus === 'saved'
      reviewStartButton.hidden = ready && memorySaved
      reviewStartButton.disabled = reviewBusy || archiveLoading || Boolean(operation)
      reviewStartButton.textContent = ready
        ? '再试一次记入记忆'
        : (reviewError ? '再试一次复盘' : '让花花复盘')
    }

    function reviewStatusLabel(record) {
      if (record.reviewStatus === 'ready') return '花花已经复盘'
      if (record.reviewStatus === 'failed') return '复盘未完成'
      return '还没有复盘'
    }

    function resultLabel(record) {
      if (record.draw) return '平局'
      if (record.winner === 1) return '主人获胜'
      if (record.winner === 2) return '花花获胜'
      return '已完成'
    }

    function formatFinishedAt(value) {
      if (!value) return '完成时间未记录'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '完成时间未记录' : date.toLocaleString('zh-CN')
    }

    function renderHistoryList() {
      historyList.replaceChildren()
      if (historyLoading && !historyRecords.length) {
        historyStatus.textContent = '正在读取棋局记录…'
        historyMoreButton.hidden = true
        return
      }
      historyStatus.textContent = historyError
        || (historyRecords.length ? '已显示 ' + historyRecords.length + ' 局棋' : '还没有完成的棋局。')
      for (const record of historyRecords) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'gomoku-history-item'
        const title = document.createElement('strong')
        title.textContent = resultLabel(record)
        const detail = document.createElement('span')
        detail.textContent = (record.moveCount || 0) + ' 手 · ' + formatFinishedAt(record.finishedAt)
        const review = document.createElement('span')
        review.textContent = reviewStatusLabel(record)
        button.append(title, detail, review)
        button.addEventListener('click', () => { void openArchive(record) })
        historyList.append(button)
      }
      historyMoreButton.hidden = !historyHasMore
      historyMoreButton.disabled = historyLoading
      historyMoreButton.textContent = historyLoading ? '正在读取…' : '更早的棋局'
    }

    function renderPanels() {
      gamePanel.hidden = historyVisible
      historyPanel.hidden = !historyVisible
      replayControls.hidden = !archiveMode
      replayPosition.textContent = game && archiveMode
        ? replayStep + ' / ' + (game.history?.length || 0) + ' 手'
        : ''
      replayPrevButton.disabled = replayStep <= 0
      replayFirstButton.disabled = replayStep <= 0
      replayNextButton.disabled = !game || replayStep >= (game.history?.length || 0)
      replayLastButton.disabled = !game || replayStep >= (game.history?.length || 0)
      replayHistoryButton.hidden = !archiveMode
      replayLiveButton.hidden = !archiveMode
    }

    function render() {
      renderPanels()
      renderHistoryList()
      if (historyVisible) {
        drawBoard()
        return
      }
      status.textContent = statusCopy()
      renderLastMove()
      renderPetTurn()

      const canMove = canChooseMove()
      playButton.disabled = !selected || !canMove
      if (selected) {
        playButton.textContent = '确认落在第 ' + (selected.row + 1) + ' 行、第 ' + (selected.col + 1) + ' 列'
      } else if (operation?.kind === 'move' || operation?.kind === 'retry' || pendingHumanMove) {
        playButton.textContent = '花花正在看棋盘…'
      } else if (displayedFinal()) {
        playButton.textContent = '这一局结束了'
      } else {
        playButton.textContent = '先选一个交叉点'
      }

      undoButton.disabled = archiveMode
        || !liveGame?.history?.length
        || Boolean(liveGame?.finishedAt || liveGame?.winner || liveGame?.draw)
        || Boolean(operation)
        || liveGame?.modelStatus === 'thinking'
      retryButton.hidden = archiveMode || (!failure && liveGame?.modelStatus !== 'failed')
      retryButton.disabled = Boolean(operation)
      restartButton.disabled = archiveMode || operation?.kind === 'start'
      historyOpenButton.disabled = historyVisible
      renderReview()
      drawBoard()
    }

    function setFailureMessage(kind, payload, response) {
      if (payload?.game?.modelStatus === 'failed') return ''
      if (response?.status === 409 && kind === 'undo') return '花花还在看棋盘，等她想好后再悔棋。'
      if (response?.status === 409 && kind === 'move') return '棋盘刚刚更新了，请重新选一个空位。'
      if (payload?.error === 'invalid-move') return '这个位置现在不能落子，请换一个空位。'
      return '暂时连不上花花的本地棋局服务，请检查连接后再试。'
    }

    async function performLive(kind, url, body, targetId = null) {
      const token = setOperation(kind, targetId)
      try {
        const { response, payload } = await requestJson(body === undefined ? 'GET' : 'POST', url, body)
        if (!ownsOperation(token)) return
        if (kind === 'sync' && response.status === 404 && !payload?.game) {
          liveGame = null
          if (!archiveMode) game = null
          pendingHumanMove = null
          clearRememberedGame()
          failure = ''
          recovery = 'start'
          if (!archiveMode) void startGame()
          return
        }
        if (payload?.game) applyLiveGame(payload.game)

        if (response.ok && payload?.ok !== false) {
          failure = ''
          return
        }

        if (payload?.game) {
          failure = ''
          notice = setFailureMessage(kind, payload, response)
        } else {
          failure = setFailureMessage(kind, payload, response)
          recovery = kind === 'start' ? 'start' : 'sync'
        }
      } catch {
        if (!ownsOperation(token)) return
        failure = '暂时连不上花花的本地棋局服务，请检查连接后再试。'
        recovery = kind === 'start' ? 'start' : 'sync'
      } finally {
        if (ownsOperation(token)) {
          operation = null
          render()
          schedulePoll()
        }
      }
    }

    function startGame() {
      if (operation?.kind === 'start') return
      if (archiveMode) {
        archiveMode = false
        historyVisible = false
        game = liveGame
      }
      pendingHumanMove = null
      recovery = 'start'
      return performLive('start', START_URL, {})
    }

    function refreshGame() {
      const id = liveGame?.id || gameId
      if (!id || operation) return
      recovery = 'sync'
      return performLive('sync', '/api/pet/gomoku/' + encodeURIComponent(id), undefined, id)
    }

    function postLiveAction(kind, suffix, body = {}) {
      if (!liveGame?.id || operation || archiveMode) return
      return performLive(
        kind,
        '/api/pet/gomoku/' + encodeURIComponent(liveGame.id) + suffix,
        body,
        liveGame.id,
      )
    }

    function confirmMove() {
      if (!selected || !canChooseMove()) return
      const move = selected
      pendingHumanMove = { row: move.row, col: move.col, gameId: liveGame.id }
      recovery = 'sync'
      render()
      return postLiveAction('move', '/move', { row: move.row, col: move.col })
    }

    function chooseAt(row, col) {
      if (!canChooseMove()) return
      if (liveGame.board[row][col] !== 0) {
        selected = null
        notice = '这个位置已经有棋子，换一个交叉点吧。'
        render()
        return
      }
      selected = { row, col }
      cursor = { row, col }
      notice = ''
      render()
    }

    function pointerChoose(event) {
      if (!canChooseMove()) return
      const rect = canvas.getBoundingClientRect()
      const padding = Math.max(16, Math.round(rect.width * 0.045))
      const gap = (rect.width - padding * 2) / (SIZE - 1)
      const col = Math.max(0, Math.min(SIZE - 1, Math.round((event.clientX - rect.left - padding) / gap)))
      const row = Math.max(0, Math.min(SIZE - 1, Math.round((event.clientY - rect.top - padding) / gap)))
      chooseAt(row, col)
    }

    function keyboardMove(event) {
      const directions = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      }
      const delta = directions[event.key]
      if (delta && canChooseMove()) {
        event.preventDefault()
        cursor = {
          row: Math.max(0, Math.min(SIZE - 1, cursor.row + delta[0])),
          col: Math.max(0, Math.min(SIZE - 1, cursor.col + delta[1])),
        }
        selected = { ...cursor }
        notice = ''
        render()
        return
      }
      if ((event.key === 'Enter' || event.key === ' ') && canChooseMove()) {
        event.preventDefault()
        if (!selected) {
          selected = { ...cursor }
          render()
        } else {
          void confirmMove()
        }
      }
    }

    async function loadHistory(append = false) {
      if (historyLoading) return
      if (!append) {
        historyRecords = []
        historyOffset = 0
        historyHasMore = false
      }
      historyLoading = true
      historyError = ''
      renderHistoryList()
      try {
        const { response, payload } = await requestJson(
          'GET',
          '/api/pet/gomoku/history?offset=' + historyOffset,
        )
        if (!historyVisible) return
        if (!response.ok || payload?.ok === false) {
          historyError = '暂时无法读取棋局记录，请稍后再试。'
          return
        }
        const page = payload.games || []
        historyRecords = append ? historyRecords.concat(page) : page
        historyOffset += page.length
        historyHasMore = typeof payload.hasMore === 'boolean' ? payload.hasMore : page.length >= 30
      } catch {
        if (historyVisible) historyError = '暂时无法读取棋局记录，请检查连接后再试。'
      } finally {
        historyLoading = false
        renderHistoryList()
      }
    }

    function openHistory() {
      historyVisible = true
      historyError = ''
      render()
      void loadHistory(false)
    }

    async function openArchive(record) {
      if (archiveLoading) return
      historyVisible = false
      archiveMode = true
      archiveLoading = true
      archiveError = ''
      reviewError = ''
      game = null
      selected = null
      render()
      try {
        const { response, payload } = await requestJson('GET', '/api/pet/gomoku/' + encodeURIComponent(record.id))
        if (!historyVisible && response.ok && payload?.game) applyArchiveGame(payload.game)
        else if (!response.ok || !payload?.game) archiveError = '无法读取这局棋，请稍后再试。'
      } catch {
        archiveError = '暂时无法读取这局棋，请检查连接后再试。'
      } finally {
        archiveLoading = false
        render()
      }
    }

    function returnToHistory() {
      historyVisible = true
      archiveError = ''
      render()
    }

    function returnToLiveGame() {
      historyVisible = false
      archiveMode = false
      archiveError = ''
      game = liveGame
      selected = null
      render()
      if (active && !operation) {
        if (liveGame?.id || gameId) void refreshGame()
        else void startGame()
      }
    }

    async function requestReview() {
      if (!game || !displayedFinal() || reviewBusy) return
      const id = game.id
      const targetArchive = archiveMode
      reviewBusy = true
      reviewTargetId = id
      reviewError = ''
      render()
      try {
        const { response, payload } = await requestJson(
          'POST',
          '/api/pet/gomoku/' + encodeURIComponent(id) + '/review',
          {},
        )
        if (payload?.game) {
          if (targetArchive) {
            if (archiveMode && game?.id === id) game = payload.game
          } else {
            applyLiveGame(payload.game)
          }
        }
        if (!response.ok || payload?.ok === false || !payload?.game) {
          reviewError = '花花这次没有完成复盘，可以再试一次。'
        }
      } catch {
        reviewError = '暂时无法连接复盘服务，请检查连接后再试。'
      } finally {
        reviewBusy = false
        reviewTargetId = null
        render()
      }
    }

    function replayTo(step) {
      if (!archiveMode || !game) return
      replayStep = Math.max(0, Math.min(game.history?.length || 0, step))
      render()
    }

    function schedulePoll() {
      if (pollTimer || !active || operation || failure || historyVisible || archiveMode || liveGame?.modelStatus !== 'thinking') return
      pollTimer = global.setTimeout(() => {
        pollTimer = null
        if (active && !operation && !historyVisible && !archiveMode) void refreshGame()
      }, 3500)
    }

    function setActive(value) {
      const nextActive = Boolean(value)
      if (active === nextActive) return
      active = nextActive
      if (!active) {
        if (pollTimer) global.clearTimeout(pollTimer)
        pollTimer = null
        return
      }
      global.requestAnimationFrame?.(drawBoard)
      render()
      if (historyVisible || archiveMode || operation) return
      if (liveGame?.id || gameId) void refreshGame()
      else void startGame()
    }

    canvas.addEventListener('click', pointerChoose)
    canvas.addEventListener('keydown', keyboardMove)
    playButton.addEventListener('click', () => { void confirmMove() })
    undoButton.addEventListener('click', () => { void postLiveAction('undo', '/undo') })
    restartButton.addEventListener('click', () => { void startGame() })
    retryButton.addEventListener('click', () => {
      if (liveGame?.modelStatus === 'failed' && liveGame?.id) {
        void postLiveAction('retry', '/retry')
      } else if (recovery === 'start' || !(liveGame?.id || gameId)) {
        void startGame()
      } else {
        void refreshGame()
      }
    })
    historyOpenButton.addEventListener('click', openHistory)
    historyBackButton.addEventListener('click', returnToLiveGame)
    historyMoreButton.addEventListener('click', () => { void loadHistory(true) })
    replayHistoryButton.addEventListener('click', returnToHistory)
    replayLiveButton.addEventListener('click', returnToLiveGame)
    replayFirstButton.addEventListener('click', () => replayTo(0))
    replayPrevButton.addEventListener('click', () => replayTo(replayStep - 1))
    replayNextButton.addEventListener('click', () => replayTo(replayStep + 1))
    replayLastButton.addEventListener('click', () => replayTo(game?.history?.length || 0))
    reviewStartButton.addEventListener('click', () => { void requestReview() })
    global.addEventListener?.('resize', drawBoard)

    render()
    return Object.freeze({ setActive })
  }

  global.VcAiPetGomoku = Object.freeze({ createGomokuController })
})(globalThis)
