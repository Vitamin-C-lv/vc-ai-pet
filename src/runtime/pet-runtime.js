import { PetSandbox } from '../core/pet-sandbox.js'
import { createInitialState, advanceState, interact } from '../core/pet-state-engine.js'
import { assertPetPolicy } from '../core/pet-policy.js'
import { ensurePetIdentity } from '../core/pet-identity.js'
import { PetMemory } from '../memory/pet-memory.js'

export class PetRuntime {
  constructor({ sandboxRoot }) { this.sandbox = new PetSandbox(sandboxRoot); this.memory = null; this.state = null; this.identity = null }
  async initialize() {
    assertPetPolicy()
    await this.sandbox.initialize()
    this.state = await this.sandbox.readJson('world', 'state.json', null)
    if (!this.state) this.state = createInitialState()
    this.identity = await ensurePetIdentity(this.sandbox, this.state)
    this.memory = new PetMemory(this.sandbox.root)
    this.memory.seedIfFresh(this.state.bornAt)
    this.memory.migrateIdentity(this.identity)
    await this.persist()
    return this.snapshot()
  }
  snapshot() { return JSON.parse(JSON.stringify(this.state)) }
  identitySnapshot() { return JSON.parse(JSON.stringify(this.identity)) }
  async tick(now = Date.now()) { this.state = advanceState(this.state, now); await this.persist(); return this.snapshot() }
  async interact(kind = 'pet', now = Date.now()) { this.state = interact(this.state, kind, now); this.memory.rememberInteraction(kind, this.state.lifetimeInteractions); await this.persist(); return this.snapshot() }
  recall(query, k = 5) { return this.memory.recall(query, k) }
  async persist() { await this.sandbox.writeJson('world', 'state.json', this.state) }
  close() { this.memory?.close() }
}
