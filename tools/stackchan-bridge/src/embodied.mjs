import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mapPetStateToBodyContract } from './contract.mjs'
import { isAllowedLanAddress } from './lan-guard.mjs'
const run = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const data = process.env.STACKCHAN_DATA_DIR
if (!data) throw Error('STACKCHAN_DATA_DIR required')
await mkdir(data, {recursive:true})
const upstream = process.env.VC_AI_PET_UPSTREAM || 'http://127.0.0.1:17870'
const status = { deviceSeenAt:null, stateRequests:0, lastAck:null, camera:null, microphone:null, speech:null }
let capture = false, record = false, audio = null, speaking = false
const json = (res,code,value) => { res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value)) }
async function body(req,limit=1024*1024) { const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>limit)throw Error('body-too-large');chunks.push(c)}return Buffer.concat(chunks) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function speak(text) {
  if(speaking) throw Error('speech-busy')
  speaking=true
  try {
    await writeFile(join(data,'speech.txt'),text,'utf8')
    await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'../speak-local.ps1'),'-TextFile',join(data,'speech.txt'),'-OutputFile',join(data,'speech.pcm')],{windowsHide:true,timeout:90000})
    audio=await readFile(join(data,'speech.pcm'))
    status.speech={queuedAt:new Date().toISOString(),bytes:audio.length}
  } finally {speaking=false}
}
async function askHuahuaAboutCamera(attachmentId) {
  const submissionId=`stackchan-camera-${Date.now().toString(36)}`
  const started=await fetch(upstream+'/api/pet/chat/start',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      submissionId,
      attachmentId,
      message:'花花通过实体身体的摄像头主动看了看现实环境。请直接告诉主人你看到了什么。',
    }),
    signal:AbortSignal.timeout(10000),
  })
  const startResult=await started.json()
  if(!started.ok || !startResult.turnId) throw Error(startResult.error||'vision-turn-start-failed')

  const replies=[]
  let after=0
  for(let attempt=0;attempt<160;attempt++) {
    const response=await fetch(`${upstream}/api/pet/chat/turn/${startResult.turnId}?after=${after}`,{
      signal:AbortSignal.timeout(5000),
    })
    if(!response.ok) throw Error('vision-turn-poll-failed')
    const turn=await response.json()
    after=turn.lastSeq??after
    for(const event of turn.events??[]) {
      if(event.type==='assistant_message' && typeof event.payload?.text==='string') replies.push(event.payload.text)
    }
    if(turn.status==='done') {
      const reply=replies.join('\n').trim()
      if(reply) await speak(reply)
      return {turnId:startResult.turnId,status:'done',reply,spoken:!!reply}
    }
    if(turn.status==='error') throw Error(turn.error?.code||'vision-turn-failed')
    await wait(750)
  }
  throw Error('vision-turn-timeout')
}
async function askHuahuaByVoice(message) {
  const submissionId=`stackchan-voice-${Date.now().toString(36)}`
  const started=await fetch(upstream+'/api/pet/chat/start',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({submissionId,message}),
    signal:AbortSignal.timeout(10000),
  })
  const startResult=await started.json()
  if(!started.ok || !startResult.turnId) throw Error(startResult.error||'voice-turn-start-failed')
  const replies=[]
  let after=0
  for(let attempt=0;attempt<160;attempt++) {
    const response=await fetch(`${upstream}/api/pet/chat/turn/${startResult.turnId}?after=${after}`,{
      signal:AbortSignal.timeout(5000),
    })
    if(!response.ok) throw Error('voice-turn-poll-failed')
    const turn=await response.json()
    after=turn.lastSeq??after
    for(const event of turn.events??[]) {
      if(event.type==='assistant_message' && typeof event.payload?.text==='string') replies.push(event.payload.text)
    }
    if(turn.status==='done') {
      const reply=replies.join('\n').trim()
      if(reply) await speak(reply)
      return {turnId:startResult.turnId,status:'done',reply,spoken:!!reply}
    }
    if(turn.status==='error') throw Error(turn.error?.code||'voice-turn-failed')
    await wait(750)
  }
  throw Error('voice-turn-timeout')
}
async function processMicrophone(pcmPath) {
  const speechPython=process.env.STACKCHAN_SPEECH_PYTHON||join(data,'speech-venv','Scripts','python.exe')
  const speechModel=process.env.STACKCHAN_SPEECH_MODEL||join(data,'vosk-model-small-cn-0.22')
  const result=await run(speechPython,[join(root,'../transcribe-local.py'),'--model',speechModel,'--pcm',pcmPath,'--sample-rate','24000'],{
    windowsHide:true,
    timeout:90000,
    env:{...process.env,PYTHONUTF8:'1'},
  })
  const transcript=result.stdout.trim()
  status.microphone.transcript=transcript
  if(!transcript) {
    status.microphone.voice={status:'no-speech'}
    return
  }
  status.microphone.voice=await askHuahuaByVoice(transcript)
}
const server=createServer(async(req,res)=>{
 try {
  if(!isAllowedLanAddress(req.socket.remoteAddress)) return json(res,403,{error:'lan-only'})
  const path=new URL(req.url,'http://local').pathname
  if(req.method==='GET' && path==='/healthz')return json(res,200,{ok:true,...status})
  if(req.method==='GET' && path==='/v1/body/state') {
    const response=await fetch(upstream+'/api/pet/state',{signal:AbortSignal.timeout(1500)})
    if(!response.ok) throw Error('upstream-state-unavailable')
    const state=await response.json();status.deviceSeenAt=new Date().toISOString();status.stateRequests++
    return json(res,200,mapPetStateToBodyContract(state,{reachable:true,observedAt:status.deviceSeenAt,stateAgeMs:0}))
  }
  if(req.method==='GET' && path==='/v1/body/commands') {
    json(res,200,{capture,record,audio:!!audio});capture=false;record=false;return
  }
  if(req.method==='GET' && path==='/v1/body/audio') {
    if(!audio) return json(res,204,{})
    const pcm=audio;audio=null;res.writeHead(200,{'content-type':'audio/pcm','content-length':pcm.length});res.end(pcm);return
  }
  if(req.method==='GET' && path==='/v1/body/camera/latest') {
    const image=await readFile(join(data,'camera.jpg'));res.writeHead(200,{'content-type':'image/jpeg','content-length':image.length});res.end(image);return
  }
  if(req.method==='POST' && path==='/v1/body/ack') {
    status.lastAck={...JSON.parse(await body(req)),at:new Date().toISOString()};console.log('DEVICE_ACK',JSON.stringify(status.lastAck));return json(res,200,{ok:true})
  }
  if(req.method==='POST' && path==='/v1/body/camera') {
    const image=await body(req);if(image[0]!==255||image[1]!==216) throw Error('not-jpeg')
    const cameraPath=join(data,'camera.jpg')
    const thumbnailPath=join(data,'camera-thumbnail.jpg')
    await writeFile(cameraPath,image)
    await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
      '-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'../thumbnail-local.ps1'),
      '-InputFile',cameraPath,'-OutputFile',thumbnailPath,
    ],{windowsHide:true,timeout:30000})
    const imageDto={dataUrl:'data:image/jpeg;base64,'+image.toString('base64')}
    const thumbnail=await readFile(thumbnailPath)
    const thumbnailDto={dataUrl:'data:image/jpeg;base64,'+thumbnail.toString('base64')}
    const upload=await fetch(upstream+'/api/pet/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:imageDto,thumbnail:thumbnailDto}),signal:AbortSignal.timeout(10000)})
    const result=await upload.json();status.camera={at:new Date().toISOString(),bytes:image.length,uploaded:upload.ok,attachmentId:result.attachment?.id,error:result.error}
    if(upload.ok && result.attachment?.id) {
      status.camera.vision={status:'running'}
      void askHuahuaAboutCamera(result.attachment.id).then((vision)=>{
        status.camera.vision=vision
        console.log('CAMERA_VISION',JSON.stringify(status.camera))
      }).catch((error)=>{
        status.camera.vision={status:'error',error:error.message}
        console.error('CAMERA_VISION_ERROR',error.message)
      })
    }
    console.log('CAMERA',JSON.stringify(status.camera));return json(res,upload.ok?200:502,status.camera)
  }
  if(req.method==='POST' && path==='/v1/body/microphone') {
    const pcm=await body(req);const pcmPath=join(data,'microphone.pcm');await writeFile(pcmPath,pcm)
    status.microphone={at:new Date().toISOString(),bytes:pcm.length,sampleRate:24000,voice:{status:'running'}}
    void processMicrophone(pcmPath).then(()=>console.log('MICROPHONE',JSON.stringify(status.microphone))).catch((error)=>{
      status.microphone.voice={status:'error',error:error.message}
      console.error('MICROPHONE_ERROR',error.message)
    })
    return json(res,200,{ok:true})
  }
  if(req.method==='POST' && path==='/v1/body/control') {
    const value=JSON.parse(await body(req,16384))
    if(value.capture)capture=true
    if(value.record)record=true
    if(value.reprocessMicrophone) {
      const pcmPath=join(data,'microphone.pcm')
      status.microphone={...(status.microphone??{}),voice:{status:'running'}}
      void processMicrophone(pcmPath).then(()=>console.log('MICROPHONE',JSON.stringify(status.microphone))).catch((error)=>{
        status.microphone.voice={status:'error',error:error.message}
        console.error('MICROPHONE_ERROR',error.message)
      })
    }
    if(typeof value.speak==='string' && value.speak.length>0 && value.speak.length<=2000)await speak(value.speak)
    return json(res,200,{ok:true})
  }
  return json(res,404,{error:'not-found'})
 }catch(error){console.error('REQUEST_ERROR',error.message);return json(res,500,{error:error.message})}
})
server.listen(17871,process.env.STACKCHAN_BRIDGE_BIND||'127.0.0.1',()=>console.log('BODY_BRIDGE_READY'))
const discovery=createSocket('udp4')
discovery.on('message',(message,peer)=>{
 if(message.toString()==='LIHUAHUA_DISCOVER_V1' && isAllowedLanAddress(peer.address))
  discovery.send('LIHUAHUA_BODY_V1 17871',peer.port,peer.address)
})
discovery.bind(17872,'0.0.0.0')
