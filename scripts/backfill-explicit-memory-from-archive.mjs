#!/usr/bin/env node
/**
 * One-time, local-only repair for explicit memory requests found in the raw
 * conversation archive. The archive is opened read-only and no model is used.
 */

import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { MemoryGate } from '../src/memory/memory-gate.js'
import {
  highPriorityMemoryCandidate,
  userExplicitlyRequestsMemory,
} from '../src/brain/memory-candidate.js'
import { PetMemory } from '../src/memory/pet-memory.js'

function parseArgs(argv) {
  const options = { apply: false, json: false, sandbox: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--json') options.json = true
    else if (arg === '--sandbox') options.sandbox = argv[index += 1] ?? null
    else if (arg.startsWith('--sandbox=')) options.sandbox = arg.slice('--sandbox='.length)
  }
  return options
}

function messageIdFor(row, payload) {
  const value = payload?.id ?? row?.id
  const text = String(value ?? '').trim()
  return text ? text.slice(0, 80) : null
}

function createDryRunMemory(realMemory) {
  const simulatedRows = []
  return {
    findEquivalentMemory(content) {
      return realMemory.findEquivalentMemory(content)
        ?? simulatedRows.find((row) => row.content === content)
        ?? null
    },
    rememberCandidate(candidate) {
      const row = { id: `dry-run-${simulatedRows.length + 1}`, ...candidate }
      simulatedRows.push(row)
      return row
    },
  }
}

function archiveMessages(archiveDb) {
  return archiveDb.prepare(`
    SELECT sequence, id, role, payload
    FROM raw_messages
    WHERE role = 'user'
    ORDER BY sequence ASC
  `).all()
}

function inspectMemoryCount(memory) {
  return ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
    .reduce((total, level) => total + memory.db.list(level).length, 0)
}

function lineReport(report) {
  const lines = [
    `SCANNED_USER_MESSAGES=${report.scannedUserMessages}`,
    `EXPLICIT_CANDIDATES=${report.explicitCandidates}`,
    `WOULD_WRITE=${report.wouldWrite}`,
    `DUPLICATES=${report.duplicates}`,
    `SENSITIVE_REJECTED=${report.sensitiveRejected}`,
    `OTHER_SKIPPED=${report.otherSkipped}`,
  ]
  if (report.apply) lines.push(`IDEMPOTENT=${report.wouldWrite === 0 ? 'YES' : 'NO'}`)
  return `${lines.join('\n')}\n`
}

export async function runBackfill({ sandboxRoot, apply = false }) {
  const root = resolve(sandboxRoot)
  const archivePath = join(root, 'conversation-archive.db')
  const archiveDb = new DatabaseSync(archivePath, { readOnly: true })
  const memory = new PetMemory(root)
  const gateMemory = apply ? memory : createDryRunMemory(memory)
  const gate = new MemoryGate({ memory: gateMemory })
  const report = {
    apply,
    scannedUserMessages: 0,
    explicitCandidates: 0,
    wouldWrite: 0,
    duplicates: 0,
    sensitiveRejected: 0,
    otherSkipped: 0,
  }

  try {
    for (const row of archiveMessages(archiveDb)) {
      report.scannedUserMessages += 1
      let payload
      try {
        payload = JSON.parse(String(row.payload ?? ''))
      } catch {
        report.otherSkipped += 1
        continue
      }
      const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
      if (!text) {
        report.otherSkipped += 1
        continue
      }

      const explicit = userExplicitlyRequestsMemory(text)
      const candidate = explicit ? highPriorityMemoryCandidate(text) : null
      if (candidate) report.explicitCandidates += 1
      const result = gate.consider(text, null, {
        messageId: messageIdFor(row, payload),
        explicitFallback: candidate,
      })
      if (result.status === 'written') report.wouldWrite += 1
      else if (result.status === 'duplicate') report.duplicates += 1
      else if (result.reason === 'memory-sensitive-reject') report.sensitiveRejected += 1
      else report.otherSkipped += 1
    }
    return report
  } finally {
    archiveDb.close()
    memory.close()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.sandbox) {
    const usage = 'usage: node scripts/backfill-explicit-memory-from-archive.mjs --sandbox <dir> [--apply] [--json]'
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: 'SANDBOX_REQUIRED' }, null, 2)}\n`)
    else process.stderr.write(`${usage}\n`)
    process.exitCode = 2
    return
  }

  try {
    const report = await runBackfill({ sandboxRoot: options.sandbox, apply: options.apply })
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write(lineReport(report))
  } catch (error) {
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: 'BACKFILL_FAILED' }, null, 2)}\n`)
    else process.stderr.write(`BACKFILL_FAILED=${error?.code ?? error?.message ?? 'unknown'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) await main()
