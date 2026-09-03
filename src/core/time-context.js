const WEEKDAYS = Object.freeze([
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
])

export const TIME_CONTEXT_FIELDS = Object.freeze([
  'currentDate',
  'currentTime',
  'weekday',
  'dayPeriod',
  'season',
])

function pad(value) {
  return String(value).padStart(2, '0')
}

function dateFromInput(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('VC_AI_PET_TIME_CONTEXT_DATE_INVALID')
  return date
}

function dayPeriodForHour(hour) {
  if (hour < 6) return '凌晨'
  if (hour < 12) return '上午'
  if (hour < 18) return '下午'
  return '晚上'
}

function seasonForMonth(month) {
  if (month >= 3 && month <= 5) return '春季'
  if (month >= 6 && month <= 8) return '夏季'
  if (month >= 9 && month <= 11) return '秋季'
  return '冬季'
}

/**
 * Read the local system clock once and expose only the current calendar/time
 * context needed by the Pet. The returned snapshot is ephemeral and carries
 * no memory, conversation, Dream, or Historical Recall data.
 */
export function getCurrentTimeContext(now = Date.now()) {
  const date = dateFromInput(now)
  const hour = date.getHours()
  const month = date.getMonth() + 1

  return Object.freeze({
    currentDate: `${date.getFullYear()}-${pad(month)}-${pad(date.getDate())}`,
    currentTime: `${pad(hour)}:${pad(date.getMinutes())}`,
    weekday: WEEKDAYS[date.getDay()],
    dayPeriod: dayPeriodForHour(hour),
    season: seasonForMonth(month),
  })
}

// These aliases keep the provider easy to discover without creating separate
// clock implementations at call sites.
export const createTimeContext = getCurrentTimeContext
export const provideTimeContext = getCurrentTimeContext
