function timestamp(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

export async function readVisualUploadTimes(store, attachment) {
  if (!attachment) return []
  const uploads = store?.uploadHistoryForAttachment
    ? await store.uploadHistoryForAttachment(attachment.id) : []
  const times = uploads.map((upload) => timestamp(upload.uploadedAt)).filter(Boolean)
  // File creation and owner-message receipt may differ by milliseconds. They
  // describe one upload, so add creation time only for an unindexed attachment.
  if (!uploads.some((upload) => upload.attachmentId === attachment.id)) {
    const fallback = timestamp(attachment.createdAt)
    if (fallback) times.push(fallback)
  }
  return times.sort((left, right) => left - right)
}

function localTime(value) {
  const time = timestamp(value)
  return time ? new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知'
}

export function formatVisualTimeContext({ uploadedAt = null, uploadTimes = [], now = Date.now(), imageRelation = null } = {}) {
  const times = uploadTimes.map(timestamp).filter(Boolean)
  if (!times.length && timestamp(uploadedAt)) times.push(timestamp(uploadedAt))
  return `图片时间信息（时区 Asia/Shanghai）：\n当前时间：${localTime(now)}\n当前查看来源：${imageRelation === 'current' ? '主人本轮上传的图片' : imageRelation === 'recalled' ? '从图库或以前对话调取的图片' : '查看图片'}\n已记录主人上传次数：${times.length || '未知'}\n这张图片各次上传时间：${times.length ? times.map(localTime).join('；') : '未知'}\n这些时间是主人上传图片的时间，不是拍摄时间；花花自己重新展示旧图不算主人上传。请结合各次上传时间、当前时间和主人原话，自行判断是在谈当前、刚才还是过去的画面。重复上传的图可以是主人再次谈论当前情况，不要仅凭最早上传时间断定本轮是过去；也不要把调取旧图的时间误当成新的上传时间。`
}
