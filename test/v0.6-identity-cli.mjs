import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { IdentityStore } from '../src/identity/identity-store.js'

const TIMEOUT_MS = 5000
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(repoRoot, 'scripts', 'identity-create-person.mjs')

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], ...options })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { child, get stdout() { return stdout }, get stderr() { return stderr } }
}

async function collectProcess(processState) {
  let timedOut = false
  const closed = new Promise((resolveClose, rejectClose) => {
    processState.child.once('error', rejectClose)
    processState.child.once('close', (code, signal) => resolveClose({ code, signal }))
  })
  const timeout = setTimeout(() => {
    timedOut = true
    processState.child.kill('SIGKILL')
  }, TIMEOUT_MS)
  try {
    const result = await closed
    return { ...result, timedOut, stdout: processState.stdout, stderr: processState.stderr }
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForMarker(processState, marker) {
  const deadline = Date.now() + TIMEOUT_MS
  while (!processState.stdout.includes(marker)) {
    if (Date.now() >= deadline) throw new Error(`PTY_PROMPT_TIMEOUT:${marker}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
}

function startPty(root) {
  const command = `${process.execPath} ${cliPath} --sandbox-root ${root}`
  return startProcess('script', ['--quiet', '--flush', '--return', '--echo', 'never', '--command', command, '/dev/null'])
}

async function runPty(root, steps) {
  const processState = startPty(root)
  try {
    for (const step of steps) {
      await waitForMarker(processState, step.marker)
      const chunks = Array.isArray(step.data) ? step.data : [step.data]
      for (const chunk of chunks) {
        processState.child.stdin.write(chunk, Buffer.isBuffer(chunk) ? undefined : 'utf8')
        if (step.delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, step.delayMs))
      }
    }
    processState.child.stdin.end()
    return await collectProcess(processState)
  } catch (error) {
    if (processState.child.exitCode === null && processState.child.signalCode === null) {
      processState.child.kill('SIGKILL')
      try { await once(processState.child, 'close') } catch {}
    }
    throw error
  }
}

async function runNoTty(root) {
  const processState = startProcess(process.execPath, [cliPath, '--sandbox-root', root])
  processState.child.stdin.end()
  return collectProcess(processState)
}

async function counts(root) {
  const dbPath = join(root, 'identity.sqlite')
  try {
    await access(dbPath)
  } catch {
    return { exists: false, people: 0, credentials: 0 }
  }
  const db = new DatabaseSync(dbPath)
  try {
    return {
      exists: true,
      people: db.prepare('SELECT COUNT(*) AS count FROM people').get().count,
      credentials: db.prepare('SELECT COUNT(*) AS count FROM credentials').get().count,
    }
  } finally {
    db.close()
  }
}

function assertNoPassword(result, password) {
  assert.equal(result.stdout.includes(password), false)
  assert.equal(result.stderr.includes(password), false)
}

function assertSingleHiddenNewline(result) {
  assert.match(result.stdout, /Password: \r?\n(?!\r?\n)/u)
  if (result.stdout.includes('Confirm password: ')) assert.match(result.stdout, /Confirm password: \r?\n(?!\r?\n)/u)
}

function standardSteps(password, username, displayName = 'CLI User') {
  return [
    { marker: 'Username: ', data: `${username}\n` },
    { marker: 'Display name: ', data: `${displayName}\n` },
    { marker: 'Relationship (optional): ', data: 'family\n' },
    { marker: 'Pet address name (optional): ', data: '测试\n' },
    { marker: 'Password: ', data: `${password}\n` },
    { marker: 'Confirm password: ', data: `${password}\n` },
  ]
}

async function main() {
  const scriptProbe = spawnSync('script', ['--version'], { encoding: 'utf8' })
  assert.equal(scriptProbe.error, undefined)
  assert.equal(scriptProbe.status, 0)

  const noTtyRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-identity-cli-no-tty-'))
  const asciiRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-identity-cli-ascii-'))
  const mismatchRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-identity-cli-mismatch-'))
  const ctrlCRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-identity-cli-ctrl-c-'))
  const utf8Root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-identity-cli-utf8-'))
  try {
    const noTty = await runNoTty(noTtyRoot)
    assert.equal(noTty.timedOut, false)
    assert.equal(noTty.code, 1)
    assert.match(noTty.stdout, /IDENTITY_CREATE_FAILED=IDENTITY_CLI_TTY_REQUIRED/u)
    assert.deepEqual(await counts(noTtyRoot), { exists: false, people: 0, credentials: 0 })

    const asciiPassword = 'AsciiPass123'
    const ascii = await runPty(asciiRoot, standardSteps(asciiPassword, 'asciiuser'))
    assert.equal(ascii.timedOut, false)
    assert.equal(ascii.code, 0)
    assert.match(ascii.stdout, /PERSON_CREATED/u)
    assertNoPassword(ascii, asciiPassword)
    assertSingleHiddenNewline(ascii)
    const asciiStore = new IdentityStore(asciiRoot)
    await asciiStore.initialize()
    try {
      assert.equal((await asciiStore.verifyPassword({ username: 'asciiuser', password: asciiPassword })).ok, true)
    } finally {
      asciiStore.close()
    }

    const mismatchPassword = 'MismatchPass123'
    const mismatch = await runPty(mismatchRoot, [
      ...standardSteps(mismatchPassword, 'mismatchuser').slice(0, -1),
      { marker: 'Confirm password: ', data: 'DifferentPass123\n' },
    ])
    assert.equal(mismatch.timedOut, false)
    assert.equal(mismatch.code, 1)
    assert.match(mismatch.stdout, /IDENTITY_CREATE_FAILED=IDENTITY_PASSWORD_CONFIRMATION_MISMATCH/u)
    assertNoPassword(mismatch, mismatchPassword)
    assertSingleHiddenNewline(mismatch)
    assert.deepEqual(await counts(mismatchRoot), { exists: false, people: 0, credentials: 0 })

    const ctrlCPassword = 'NeverEchoThis123'
    const ctrlC = await runPty(ctrlCRoot, [
      { marker: 'Username: ', data: 'canceluser\n' },
      { marker: 'Display name: ', data: 'Cancelled\n' },
      { marker: 'Relationship (optional): ', data: '\n' },
      { marker: 'Pet address name (optional): ', data: '\n' },
      { marker: 'Password: ', data: `${ctrlCPassword}\u0003` },
    ])
    assert.equal(ctrlC.timedOut, false)
    assert.equal(ctrlC.code, 1)
    assert.match(ctrlC.stdout, /IDENTITY_CREATE_FAILED=IDENTITY_CLI_CANCELLED/u)
    assertNoPassword(ctrlC, ctrlCPassword)
    assertSingleHiddenNewline(ctrlC)

    const utf8Password = '花花密码123🐾'
    const utf8Bytes = Buffer.from(`${utf8Password}\n`, 'utf8')
    const utf8Steps = standardSteps(utf8Password, 'utf8user', 'UTF-8 User')
    utf8Steps[4] = {
      marker: 'Password: ',
      data: [utf8Bytes.subarray(0, 1), utf8Bytes.subarray(1)],
      delayMs: 50,
    }
    const utf8 = await runPty(utf8Root, utf8Steps)
    assert.equal(utf8.timedOut, false)
    assert.equal(utf8.code, 0)
    assert.match(utf8.stdout, /PERSON_CREATED/u)
    assertNoPassword(utf8, utf8Password)
    assertSingleHiddenNewline(utf8)
    const utf8Store = new IdentityStore(utf8Root)
    await utf8Store.initialize()
    try {
      assert.equal((await utf8Store.verifyPassword({ username: 'utf8user', password: utf8Password })).ok, true)
    } finally {
      utf8Store.close()
    }

    console.log('CLI_NO_TTY=PASS')
    console.log('CLI_ASCII_PTY=PASS')
    console.log('CLI_PASSWORD_NOT_ECHOED=PASS')
    console.log('CLI_MISMATCH_NO_ROWS=PASS')
    console.log('CLI_CTRL_C_RESTORE=PASS')
    console.log('CLI_UTF8_PASSWORD=PASS')
    console.log('CLI_EXIT_NO_HANG=PASS')
  } finally {
    await Promise.all([noTtyRoot, asciiRoot, mismatchRoot, ctrlCRoot, utf8Root].map((root) => rm(root, { recursive: true, force: true })))
  }
}

await main()
