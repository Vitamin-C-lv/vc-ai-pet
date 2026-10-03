(function installMessageHeadpat(global) {
  function attach(node, { id, liked = false } = {}) {
    if (!id) return
    node.dataset.messageId = id
    const actions = document.createElement('div')
    actions.className = 'message-actions'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-headpat'
    button.title = '摸摸头，表示喜欢这条回答；再次点击可以取消'
    const status = document.createElement('span')
    status.className = 'message-headpat-status'
    status.setAttribute('role', 'status')
    const render = () => {
      button.textContent = liked ? '🐾 已摸摸头' : '🐾 摸摸头'
      button.setAttribute('aria-label', liked ? '取消喜欢这条回答' : '摸摸头，喜欢这条回答')
      button.setAttribute('aria-pressed', String(liked))
    }
    render()
    button.addEventListener('click', async () => {
      button.disabled = true
      status.textContent = ''
      try {
        const response = await global.fetch(`/api/pet/messages/${encodeURIComponent(id)}/headpat`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ liked: !liked }),
        })
        const payload = await response.json()
        if (!response.ok || payload.ok !== true || typeof payload.feedback?.headpat !== 'boolean') throw new Error('headpat-failed')
        liked = payload.feedback.headpat
        render()
      } catch {
        status.textContent = '没能保存，点一下重试'
      } finally { button.disabled = false }
    })
    actions.append(button, status)
    node.append(actions)
  }
  global.VcAiPetHeadpat = Object.freeze({ attach })
})(globalThis)
