import { access, mkdir } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { validateLocalBrainConfig } from './local-brain-config.js'
import { buildPetMessages } from './prompt-builder.js'
import { PET_CHAT_RESPONSE_SCHEMA, MEMORY_OUTPUT_INSTRUCTION, parseStructuredChatResponse } from './memory-candidate.js'
import { assertLoopbackUrl } from '../core/pet-policy.js'
import { evaluateLocalBrainAvailability, busyPetLine } from './resource-gate.js'
import { BrainAvailabilityTracker } from './brain-availability.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const execFileAsync = promisify(execFile)

function runtimeModelPath(config) {
  if (config.serverBinary.toLowerCase().endsWith('.exe') && config.modelPath.startsWith('/mnt/d/')) {
    return `D:/${config.modelPath.slice('/mnt/d/'.length)}`
  }
  return config.modelPath
}

function usesWindowsRuntime(config) {
  return config.serverBinary.toLowerCase().endsWith('.exe')
}

async function requestLocalServer(config, path, { method = 'GET', body = null, timeoutMs = 1_500 } = {}) {
  const url = assertLoopbackUrl(`${config.baseUrl}${path}`)
  if (!usesWindowsRuntime(config)) {
    return fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  const args = ['--fail', '--silent', '--show-error', '--max-time', String(Math.ceil(timeoutMs / 1000))]
  if (method !== 'GET') args.push('--request', method)
  if (body) args.push('--header', 'content-type: application/json', '--data-binary', body)
  args.push(url.toString())

  const { stdout } = await execFileAsync('curl.exe', args, {
    timeout: timeoutMs + 1_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })

  return {
    ok: true,
    json: async () => JSON.parse(stdout),
  }
}

export class LocalBrain {
  constructor({ config = {}, memory, sandbox = null }) {
    this.config = validateLocalBrainConfig(config)
    this.memory = memory
    this.sandbox = sandbox
    this.availability = sandbox ? new BrainAvailabilityTracker({ sandbox }) : null
    this.child = null
    this.startPromise = null
    this.inferenceActive = false
    this.monitorTimer = null
  }

  async prepareStorage() {
    await Promise.all([
      mkdir(this.config.modelDir, { recursive: true }),
      mkdir(this.config.cacheDir, { recursive: true }),
      mkdir(this.config.tempDir, { recursive: true }),
    ])
  }

  async validateInstalledFiles() {
    await access(this.config.modelPath)
    await access(this.config.serverBinary)
    return true
  }

  async health() {
    try {
      const response = await requestLocalServer(this.config, '/health')
      return response.ok
    } catch {
      return false
    }
  }

  async checkAvailability() {
    const result = await evaluateLocalBrainAvailability(this.config.resourceGate)
    if (this.availability) await this.availability.record(result)

    return {
      ...result,
      petLine: result.available ? null : busyPetLine(result.reason),
    }
  }

  startResourceMonitor() {
    if (this.monitorTimer) return
    this.monitorTimer = setInterval(() => { void this.monitorOnce() }, this.config.resourceGate.probeIntervalMs)
    this.monitorTimer.unref?.()
  }

  async monitorOnce() {
    if (!this.child || this.inferenceActive) return
    const availability = await this.checkAvailability()
    if (!availability.available) this.stop('owner-busy')
  }

  stopResourceMonitor() {
    if (!this.monitorTimer) return
    clearInterval(this.monitorTimer)
    this.monitorTimer = null
  }

  async ensureRunning() {
    if (await this.health()) {
      this.startResourceMonitor()
      return true
    }

    if (this.startPromise) return this.startPromise

    const availability = await this.checkAvailability()
    if (!availability.available) {
      const error = new Error(`PET_LOCAL_MODEL_DEFERRED:${availability.reason}`)
      error.code = 'PET_OWNER_BUSY'
      error.availability = availability
      throw error
    }

    this.startPromise = this.start()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async start() {
    await this.prepareStorage()
    await this.validateInstalledFiles()

    const args = [
      '--model', runtimeModelPath(this.config),
      '--host', this.config.host,
      '--port', String(this.config.port),
      '--ctx-size', String(this.config.ctxSize),
      '--n-gpu-layers', String(this.config.gpuLayers),
      '--parallel', '1',
      '--sleep-idle-seconds', String(this.config.sleepIdleSeconds),
      '--alias', this.config.modelAlias,
    ]

    const env = {
      ...process.env,
      HF_HOME: this.config.cacheDir,
      HUGGINGFACE_HUB_CACHE: this.config.cacheDir,
      XDG_CACHE_HOME: this.config.cacheDir,
      TMPDIR: this.config.tempDir,
      TEMP: this.config.tempDir,
      TMP: this.config.tempDir,
    }

    this.child = spawn(this.config.serverBinary, args, {
      cwd: this.config.runtimeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: false,
    })

    this.child.stdout?.on('data', () => {})
    this.child.stderr?.on('data', () => {})
    this.child.once('exit', () => {
      this.child = null
      this.stopResourceMonitor()
    })

    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (await this.health()) {
        this.startResourceMonitor()
        return true
      }
      if (!this.child) break
      await sleep(500)
    }

    throw new Error('PET_LOCAL_MODEL_START_TIMEOUT')
  }

  async reply({ identity, state, userText }) {
    const availability = await this.checkAvailability()

    if (!availability.available) {
      return {
        ok: false,
        unavailable: true,
        reason: availability.reason,
        petLine: availability.petLine,
        sample: availability.sample,
      }
    }

    try {
      await this.ensureRunning()
    } catch (error) {
      if (error?.code === 'PET_OWNER_BUSY') {
        return {
          ok: false,
          unavailable: true,
          reason: error.availability?.reason ?? 'owner-busy',
          petLine: error.availability?.petLine ?? busyPetLine('gpu-busy'),
          sample: error.availability?.sample ?? null,
        }
      }
      throw error
    }

    const related = this.memory?.recall?.(userText, 5) ?? []
    const stable = this.memory?.stableIdentityContext?.() ?? []
    const dedup = new Map()

    for (const item of [...stable, ...related]) {
      const key = `${item.level}:${item.content}`
      if (!dedup.has(key)) dedup.set(key, item)
    }

    const messages = buildPetMessages({
      identity,
      state,
      memories: [...dedup.values()].slice(0, 8),
      userText,
    })

    // Keep one model inference per chat turn. The same constrained response
    // contains the visible reply and an optional memory candidate.
    messages[0] = {
      ...messages[0],
      content: `${messages[0].content}\n\n${MEMORY_OUTPUT_INSTRUCTION}`,
    }

    this.inferenceActive = true
    try {
      const response = await requestLocalServer(this.config, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: this.config.modelAlias,
          messages,
          temperature: 0.72,
          top_p: 0.9,
          max_tokens: 256,
          chat_template_kwargs: { enable_thinking: false },
          response_format: {
            type: 'json_object',
            schema: PET_CHAT_RESPONSE_SCHEMA,
          },
          stream: false,
        }),
        timeoutMs: 60_000,
      })

      if (!response.ok) throw new Error(`PET_LOCAL_MODEL_HTTP_${response.status}`)

      const payload = await response.json()
      const rawText = payload?.choices?.[0]?.message?.content
      const parsed = parseStructuredChatResponse(rawText, userText)

      return {
        ok: true,
        unavailable: false,
        text: parsed.text,
        memoryCandidate: parsed.memoryCandidate,
        rawMemoryCandidate: parsed.rawMemoryCandidate,
        memoryDecision: parsed.memoryDecision,
      }
    } finally {
      this.inferenceActive = false
    }
  }

  stop(reason = 'manual') {
    this.stopResourceMonitor()
    if (!this.child) return
    this.child.kill('SIGTERM')
    this.child = null
    this.lastStopReason = reason
  }
}
