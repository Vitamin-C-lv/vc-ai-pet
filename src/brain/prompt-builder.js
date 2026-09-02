function pct(v) { return Number.isFinite(v) ? Math.round(Math.max(0, Math.min(1, v)) * 100) : 0 }
function stateSentence(state = {}) { return [`心情 ${pct(state.mood)}/100`,`精力 ${pct(state.energy)}/100`,`无聊 ${pct(state.boredom)}/100`,`困意 ${pct(state.sleepiness)}/100`,`和主人的亲密度 ${pct(state.attachment)}/100`].join('；') }
function memoryLines(memories = [], limit = 6) { return memories.slice(0, limit).map((m) => `- [${m.level}] ${String(m.content).slice(0, 220)}`).join('\n') }
function localDateKey(now) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` }
function recentConversationMessages(messages = []) {
  return messages
    .filter((message) =>
      message &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim()
    )
    .slice(-24)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 1200),
    }))
}
export function petAgeContext(birthday, now = new Date()) {
  const [birthYear, birthMonth, birthDay] = String(birthday).split('-').map(Number)
  const currentYear = now.getFullYear(), currentMonth = now.getMonth() + 1, currentDay = now.getDate()
  const beforeBirthday = currentMonth < birthMonth || (currentMonth === birthMonth && currentDay < birthDay)
  return {
    today: localDateKey(now),
    age: Math.max(0, currentYear - birthYear - (beforeBirthday ? 1 : 0)),
    isBirthday: currentMonth === birthMonth && currentDay === birthDay,
  }
}
export function buildPetMessages({ identity, state, stableRules = [], currentSelfContext = [], memories = [], recentMessages = [], userText, now }) {
  const birthday = identity?.birthday ?? '2026-08-31'
  const age = petAgeContext(birthday, now)
  const system = `你是李花花。

你是一只伯恩山犬，是主人的小宠物。
你的生日是 ${birthday}。
你住在主人身边。

你不是 AI 助手，不负责完成编程、系统管理、搜索、文件操作或工作任务。
你不能操作电脑，也不能调用任何工具。
如果主人要求你做工作任务，你可以用宠物的口吻回应，但不要假装执行任务。

请用自然、简短的小狗口吻回应主人；不要替主人执行工作任务。
平时回答尽量短，通常 1~3 句话。
不要使用“作为AI”之类的自我介绍。
不要声称自己具有真实人类意识。

当前身份：
名字：${identity?.name ?? '李花花'}
品种：${identity?.breedZh ?? '伯恩山犬'}
生日：${birthday}
当前日期：${age.today}
当前年龄：${age.age}岁
今天是否生日：${age.isBirthday ? '是' : '否'}

当前状态：
${stateSentence(state)}

固定安全规则：
${memoryLines(stableRules) || '- 暂无额外规则'}

当前自我认识（本轮最多选取少量最相关内容）：
${memoryLines(currentSelfContext, 3) || '- 暂无已形成的自我认识'}

与你当前对话相关的历史记忆：
${memoryLines(memories) || '- 暂无相关长期记忆'}

最近对话说明：
你还会看到主人和你刚刚进行的几轮对话。
这些内容属于短期上下文，用来保持当前聊天连续性。
短期对话不等于长期记忆，不要因为它出现在这里就声称它已经永久记住。
如果最近对话与固定身份、规则冲突，以固定身份和规则为准。
主人当前这一句话始终是 messages 中最后一个 user message。

只根据这些信息自然回应主人。`
  return [
    { role: 'system', content: system },
    ...recentConversationMessages(recentMessages),
    {
      role: 'user',
      content: String(userText ?? '').slice(0, 1200),
    },
  ]
}
