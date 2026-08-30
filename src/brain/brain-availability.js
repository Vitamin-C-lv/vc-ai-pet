export class BrainAvailabilityTracker {
  constructor({ sandbox }) {
    this.sandbox = sandbox
    this.state = null
  }

  async load() {
    if (this.state) return this.state

    this.state =
      (await this.sandbox.readJson('runtime', 'brain-availability.json', null)) ?? {
        schemaVersion: 1,
        ownerBusy: false,
        reason: null,
        busySince: null,
        lastCheckedAt: null,
        lastBusyAt: null,
        lastAvailableAt: null,
        busyEpisodeCount: 0,
        lastBusyDurationMs: null,
        lastSample: null,
      }

    return this.state
  }

  async record(result, now = Date.now()) {
    const prev = await this.load()
    const busy = result.available === false

    let busySince = prev.busySince
    let busyEpisodeCount = prev.busyEpisodeCount ?? 0
    let lastBusyDurationMs = prev.lastBusyDurationMs

    if (busy && !prev.ownerBusy) {
      busySince = now
      busyEpisodeCount += 1
    }

    if (!busy && prev.ownerBusy && prev.busySince) {
      lastBusyDurationMs = Math.max(0, now - prev.busySince)
      busySince = null
    }

    this.state = {
      ...prev,
      ownerBusy: busy,
      reason: busy ? result.reason : null,
      busySince,
      lastCheckedAt: now,
      lastBusyAt: busy ? now : prev.lastBusyAt,
      lastAvailableAt: busy ? prev.lastAvailableAt : now,
      busyEpisodeCount,
      lastBusyDurationMs,
      lastSample: result.sample ?? null,
    }

    await this.sandbox.writeJson('runtime', 'brain-availability.json', this.state)
    return { ...this.state }
  }
}
