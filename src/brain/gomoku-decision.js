import { PET_REASONING_PROFILE } from './local-brain-config.js'
import { buildPetPersonaContext } from './prompt-builder.js'

const MOVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    row: { type: 'integer', minimum: 1, maximum: 15 },
    col: { type: 'integer', minimum: 1, maximum: 15 },
    mood: { type: 'string', enum: ['focused', 'confident', 'nervous', 'happy', 'disappointed', 'curious'] },
    speech: { type: 'string', maxLength: 100 },
  },
  required: ['row', 'col', 'mood', 'speech'],
}
const MOODS = new Set(MOVE_SCHEMA.properties.mood.enum)

export function gomokuBoardContext(game) {
  const stones = (player) => game.history.filter(move => move.player === player)
    .map(move => `(${move.row + 1},${move.col + 1})`).join('、') || '无'
  return [
    '列号：' + Array.from({ length: 15 }, (_, index) => index + 1).join(' '),
    ...game.board.map((row, index) => `第${index + 1}行：${row.map(cell => cell === 1 ? '黑' : cell === 2 ? '白' : '·').join(' ')}`),
    `黑棋坐标（行,列）：${stones(1)}`,
    `白棋坐标（行,列）：${stones(2)}`,
  ].join('\n')
}

// The model receives the entire position. The program checks legality only;
// it never ranks moves or supplies a replacement move when a decision fails.
export async function decideGomokuMove(client, game, memories = [], personaContext = buildPetPersonaContext()) {
  const messages = [{ role: 'system', content:
    `${personaContext}\n正在和主人认真下五子棋。你执白棋，主人执黑棋，黑先白后。`
    + '棋盘15行15列，行号与列号都从1到15。·是空点。横、竖、两种斜线连续五颗或更多同色棋子获胜，没有禁手。'
    + '现在轮到你落一颗白棋。根据完整当前棋盘独立判断最佳落点：仔细检查双方连线、可立即获胜的机会、对手威胁和下一步发展。'
    + '只能在空点落子，不得移动已有棋子。所有走法必须由你自己决定。'
    + '同时自己选择此刻的状态mood：focused专注、confident有把握、nervous紧张、happy开心、disappointed失落、curious好奇。'
    + 'speech延续上面花花的身份、当前自我认识和与主人的关系，用你平时对主人说话的口吻。根据这局局势、自己的选择或感受，自然说一句不超过100字的短话，也可以保持安静，返回空字符串。'
    + '不用每步复述坐标或规则，也不用把一句随口的话写成棋评报告；避免重复刚才说过的话。具体表达由你自己选择。'
    + 'speech是对主人公开说的话，不是内部推理过程。不要编造已经发生的落子、胜负或保证获胜。'
    + '只输出JSON对象{"row":行号,"col":列号,"mood":"状态","speech":"可选短话"}，不要输出代码或完整棋盘。'
    + (memories.length ? '\n以前棋局留下的记忆（推断只作可能的线索，当前棋盘优先；不能把一局猜测当主人固定性格）：\n'
      + memories.map(row => `[${row.provenance?.evidence ?? 'unknown'}] ${row.content}`).join('\n') : '') },
  { role: 'user', content: gomokuBoardContext(game)
    + '\n刚才你对主人说过的话（只用于表达连续性，不是棋局事实证据）：'
    + JSON.stringify(game.history.filter(move => move.player === 2 && move.speech).slice(-3).map(move => move.speech)) }]

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = Date.now()
    const response = await client.chat({
      messages, reasoningEffort: PET_REASONING_PROFILE.gomoku, maxTokens: 1792, temperature: 0.25,
      requestTimeoutMs: 90_000,
      responseFormat: { type: 'json_schema', json_schema: { name: 'huahua_gomoku_move', strict: true, schema: MOVE_SCHEMA } },
      onResponse: null,
    })
    const content = response.payload?.choices?.[0]?.message?.content
    let decision
    try { decision = JSON.parse(content) } catch { decision = null }
    const row = decision?.row - 1
    const col = decision?.col - 1
    if (Number.isInteger(decision?.row) && Number.isInteger(decision?.col)
      && row >= 0 && row < 15 && col >= 0 && col < 15 && game.board[row][col] === 0
      && MOODS.has(decision.mood) && typeof decision.speech === 'string' && decision.speech.length <= 100) {
      return { row, col, mood: decision.mood, speech: decision.speech.trim(), source: 'local-model', requestId: response.requestId ?? null, durationMs: Date.now() - startedAt }
    }
    if (attempt === 0) {
      messages.push({ role: 'user', content:
        `你刚才返回的落点${Number.isInteger(decision?.row) && Number.isInteger(decision?.col) ? `(${decision.row},${decision.col})` : '格式不正确'}不合法。`
        + '棋盘没有变化，请重新检查完整棋盘，独立选择一个空点。只输出规定的JSON对象，必须包含row、col、mood、speech，行列均为1到15的整数，mood为指定状态之一，speech为不超过100字的字符串（可以为空）。' })
    }
  }
  const error = new Error('模型没有返回合法落点')
  error.code = 'GOMOKU_MODEL_INVALID_MOVE'
  throw error
}

export async function reviewGomokuGame(client, game, personaContext = buildPetPersonaContext()) {
  const result = game.draw ? '平局' : game.winner === 1 ? '主人黑棋获胜' : '花花白棋获胜'
  const blackMoveNumbers = game.history.flatMap((move, index) => move.player === 1 ? [index + 1] : [])
  const observationSchema = kind => ({
    type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: [kind] },
      content: { type: 'string', minLength: 1, maxLength: 200 },
      moveNumbers: { type: 'array', minItems: 1, maxItems: 8, items: kind === 'style'
        ? { type: 'integer', enum: blackMoveNumbers }
        : { type: 'integer', minimum: 1, maximum: game.history.length } },
    }, required: ['kind', 'content', 'moveNumbers'],
  })
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: 400 },
      mood: MOVE_SCHEMA.properties.mood,
      speech: MOVE_SCHEMA.properties.speech,
      observations: { type: 'array', maxItems: 3, items: { anyOf: [observationSchema('style'), observationSchema('lesson')] } },
    }, required: ['summary', 'mood', 'speech', 'observations'],
  }
  const messages = [{ role: 'system', content:
      `${personaContext}\n刚和主人完成了一局五子棋，现在认真复盘。你执白，主人执黑。`
      + '以完整真实棋谱和规则给出的终局结果为依据，找转折、自己的得失，以及主人本局可能的出招习惯。'
      + 'summary给主人简短讲这局发生了什么，不能编造没有下过的棋步。mood选真实当前状态，speech可给一句自然的终局感受，也可空白。'
      + '对主人的表达沿用花花平时的口吻、上面的身份和当前自我认识；像你和主人一起回想刚才那局棋，由你根据这局经历决定如何表达。'
      + `observations至多3条，可为空。style只能描述主人黑棋的出招，引用编号只能从[${blackMoveNumbers.join(',')}]选择。白棋是你自己的出招，不能作为主人的style；自己的得失应写为lesson。`
      + 'lesson描述可改进的策略，可引用黑白双方实际棋步。'
      + '每条content写成仅基于这局的暂时理解，不得声称主人一向/总是如此，不得推断现实性格或用聊天发言作为出招证据。'
      + '引用棋步编号从1开始，必须准确。没有足够证据就少写或不写。只输出规定JSON，不输出内部推理。' },
    { role: 'user', content: `规则已确认的结果：${result}\n${gomokuBoardContext(game)}\n完整棋谱：\n`
      + game.history.map((move, index) => `第${index + 1}手：${move.player === 1 ? '主人黑棋' : '花花白棋'}(${move.row + 1},${move.col + 1})`).join('\n') }]
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await client.chat({
      messages,
      reasoningEffort: PET_REASONING_PROFILE.gomoku, maxTokens: 2304, temperature: 0.3,
      requestTimeoutMs: 90_000, onResponse: null,
      responseFormat: { type: 'json_schema', json_schema: { name: 'huahua_gomoku_review', strict: true, schema } },
    })
    let review
    try { review = JSON.parse(response.payload?.choices?.[0]?.message?.content) } catch {}
    if (!review || typeof review.summary !== 'string' || !review.summary.trim() || review.summary.length > 400
      || !MOODS.has(review.mood) || typeof review.speech !== 'string' || review.speech.length > 100
      || !Array.isArray(review.observations) || review.observations.length > 3
      || review.observations.some(observation => !['style', 'lesson'].includes(observation.kind)
        || typeof observation.content !== 'string' || !observation.content.trim() || observation.content.length > 200
        || !Array.isArray(observation.moveNumbers) || !observation.moveNumbers.length || observation.moveNumbers.length > 8
        || observation.moveNumbers.some(number => !Number.isInteger(number) || !game.history[number - 1]
          || observation.kind === 'style' && game.history[number - 1].player !== 1))) {
      if (attempt === 0) {
        messages.push({ role: 'user', content: `刚才复盘格式或引用不合法。请重新输出完整JSON。style只能写主人黑棋的倾向且引用[${blackMoveNumbers.join(',')}]中的棋步；不要将白棋的策略标记为style，自己的得失可写lesson。无法支持的观察应省略，observations可以为空。summary<=400字，speech<=100字，mood必须为指定状态，moveNumbers为合法棋步整数编号。` })
        continue
      }
      const error = new Error('模型复盘没有关联合法棋步')
      error.code = 'GOMOKU_MODEL_INVALID_REVIEW'
      throw error
    }
    return { ...review, requestId: response.requestId ?? null }
  }
}
