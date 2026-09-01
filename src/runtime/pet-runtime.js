import { PetSandbox } from '../core/pet-sandbox.js'
import { createInitialState, advanceState, interact } from '../core/pet-state-engine.js'
import { assertPetPolicy } from '../core/pet-policy.js'
import { ensurePetIdentity } from '../core/pet-identity.js'
import { PetMemory } from '../memory/pet-memory.js'
import { MemoryGate } from '../memory/memory-gate.js'
import { LocalBrain } from '../brain/local-brain.js'
import { RecentConversation } from '../conversation/recent-conversation.js'

export class PetRuntime {
  constructor({ sandboxRoot }) {
    this.sandbox = new PetSandbox(sandboxRoot)
    this.memory = null
    this.memoryGate = null
    this.brain = null
    this.state = null
    this.identity = null
    this.conversation = new RecentConversation({ maxTurns: 12 })
  }

  async initialize() {
    assertPetPolicy()
    await this.sandbox.initialize()
    this.state = await this.sandbox.readJson('world', 'state.json', null)
    if (!this.state) this.state = createInitialState()
    this.identity = await ensurePetIdentity(this.sandbox, this.state)
    this.memory = new PetMemory(this.sandbox.root)
    this.memory.seedIfFresh(this.state.bornAt)
    this.memory.migrateIdentity(this.identity)
    this.brain = new LocalBrain({ memory: this.memory, sandbox: this.sandbox })
    this.memoryGate = new MemoryGate({ memory: this.memory })
    await this.persist()
    return this.snapshot()
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state))
  }

  identitySnapshot() {
    return JSON.parse(JSON.stringify(this.identity))
  }

  async tick(now = Date.now()) {
    this.state = advanceState(this.state, now)
    await this.persist()
    return this.snapshot()
  }

  async interact(kind = 'pet', now = Date.now()) {
    this.state = interact(this.state, kind, now)
    this.memory.rememberInteraction(kind, this.state.lifetimeInteractions)
    await this.persist()
    return this.snapshot()
  }

  async chat(userText) {
    const result = await this.brain.reply({
      identity: this.identitySnapshot(),
      state: this.snapshot(),
      userText,
      recentMessages: this.conversation.messages(),
    })

    if (!result?.ok) return result

    const gate = this.memoryGate.consider(userText, result.rawMemoryCandidate ?? result.memoryCandidate)

    this.conversation.append(userText, result.text)

    // Never expose the candidate/evidence or internal gate details to the
    // browser. UI receives the same public reply shape as v0.2-C.
    return {
      ok: true,
      unavailable: false,
      text: result.text,
      memoryWrite: gate.status,
    }
  }

  recall(query, k = 5) {
    return this.memory.recall(query, k)
  }

  async persist() {
    await this.sandbox.writeJson('world', 'state.json', this.state)
  }

  close() {
    // Local Brain is now a shared external service. Pet owns no model process.
    this.conversation?.clear()
    this.memory?.close()
  }
}
