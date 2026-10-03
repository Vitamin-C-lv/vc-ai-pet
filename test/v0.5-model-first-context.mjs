import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

const root = await mkdtemp(join(tmpdir(), 'pet-model-first-'))
const runtime = new PetRuntime({ sandboxRoot: root })
const original = '昨天晚上黑莓在干什么呀'
const supplement = '你可以看看图片的拍摄时间'
const task = `主人此前尚待回答的问题：${original}\n主人本轮补充：${supplement}`
let plans = 0, searches = 0, inspections = 0, summaries = 0, resultReplies = 0
let chosen, mode = 'chat', expectedTask
const success = (text, visualRecall = null) => ({ ok: true, text, replyMessages: [text], visualRecall,
  memoryCandidate: null, rawMemoryCandidate: null, beliefCandidates: [] })
async function turn(userText, attachmentId = null) {
  const start = runtime.startChatTurn({ userText, attachmentId })
  for (let i = 0; i < 500; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    const poll = runtime.pollChatTurn(start.turnId)
    if (poll.status === 'running') continue
    assert.equal(poll.status, 'done', JSON.stringify(poll.error))
    return { ...poll, turnId: start.turnId }
  }
  assert.fail('turn did not complete')
}
try {
  await runtime.initialize()
  runtime.recentVisualResolver.resolveFromStore = () => assert.fail('pre-model recent resolver')
  runtime.turnOrchestrator.longTermResolver.resolve = () => assert.fail('pre-model long-term resolver')
  const attachments = []
  for (let i = 0; i < 2; i++) {
    const image = 'data:image/png;base64,' + Buffer.from(`image${i}`).toString('base64')
    const attachment = await runtime.conversationStore.saveAttachment({ image: { dataUrl: image },
      thumbnail: { dataUrl: image }, width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64, requireThumbnail: true })
    attachments.push(attachment)
    await runtime.conversationStore.appendMessage({ role: 'user', text: `黑莓照片${i}`, attachment })
  }
  chosen = attachments[0].id
  runtime.turnOrchestrator.semanticIndex = { async search(query) {
    searches++
    assert.equal(query, '黑莓 昨天晚上 活动')
    return { candidates: mode === 'empty' ? [] : attachments.map(a => ({attachmentId:a.id,userText:'这是黑莓'})) }
  } }
  runtime.brain = {
    async reply(request) {
      if (request.toolResultContext) {
        resultReplies++
        assert.equal(request.allowVisualRecall,false)
        assert.equal(request.userText,task,'no-result model keeps the original task')
        return success('没有找到能确认昨晚活动的照片，只有上传记录不能证明拍摄时间。')
      }
      plans++
      assert.equal(request.allowVisualRecall,true)
      assert.ok((await runtime.conversationStore.list(100)).some(row=>row.role==='user' && row.text===request.userText), 'persist owner before inference')
      if (mode === 'chat') return success('普通回复')
      if (mode === 'image') { assert.ok(request.image); assert.ok(request.recentVisuals.some(row=>row.current)); return success('看到了当前图片') }
      if (mode === 'inspect') return success('再看一眼', {tool:'inspect_visual_memory',query:'选中的照片',goal:'find_photo',attachmentIds:[chosen],ownerCaption:false})
      assert.ok(request.recentMessages.some(m=>m.role==='user' && m.content===original))
      return success('去核对记录', {tool:'search_visual_memory',query:'黑莓 昨天晚上 活动',goal:mode==='multi'?'summarize_photos':'find_photo',photoCount:2,originalQuestion:original})
    },
    async visualStep(request) {
      inspections++
      assert.equal(request.verifyRecall,true)
      assert.equal(request.userText,expectedTask)
      return {ok:true,observation:'黑莓在窗边休息',action:'answer',nextVisualId:'',focus:'窗边',match:'match',replyMessages:['看到了窗边的黑莓，时间只能依据上传记录。']}
    },
    async summarizeVisualRecall(request) {
      summaries++
      assert.equal(request.userText,task,'final summary keeps original task')
      assert.equal(request.observations.length,2)
      return {ok:true,replyMessages:['两张记录里的黑莓在窗边，不能确认实际拍摄时间。']}
    }
  }
  await turn(original)
  mode='search'; expectedTask=task
  const recalled=await turn(supplement)
  assert.equal(searches,1); assert.equal(inspections,1)
  const archive=(await runtime.conversationStore.list(100)).filter(r=>r.turnId===recalled.turnId)
  assert.deepEqual(archive.filter(r=>r.role==='user').map(r=>r.text),[supplement])
  assert.equal(recalled.events.filter(e=>e.type==='turn_started').length,1)
  const visible=recalled.events.filter(e=>['assistant_message','visual_image'].includes(e.type))
  assert.deepEqual(visible.map(e=>e.type),['assistant_message','visual_image','assistant_message'])
  mode='multi'; expectedTask=task
  await turn(supplement); assert.equal(summaries,1)
  mode='inspect'; expectedTask='你看看上一张照片'
  const beforeSearch=searches
  await turn(expectedTask); assert.equal(searches,beforeSearch,'selected image never runs gallery search')
  mode='empty'; await turn(supplement); assert.equal(resultReplies,1)
  mode='chat'
  for (const phrase of ['找错了不是客厅，是方脑袋机器人','这张照片就是黑莓','去图库看看','为什么你看了照片像机器人','我要听！快讲讲']) {
    const before=plans
    await turn(phrase)
    assert.equal(plans,before+1,'every phrase reaches the model')
  }
  assert.equal(searches,beforeSearch+1,'null plans cannot retrieve')
  mode='image'; await turn('当前上传的图片',chosen)
  assert.equal(inspections,4,'new image null plan is answered by the first vision model, not auto-routed')
  console.log('MODEL_FIRST_VISUAL_CONTEXT=PASS')
} finally { runtime.close(); await rm(root,{recursive:true,force:true}) }
