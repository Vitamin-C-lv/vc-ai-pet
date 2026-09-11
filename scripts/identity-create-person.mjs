import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { IdentityStore } from '../src/identity/identity-store.js'

function usage() {
  stdout.write('Usage: npm run identity:create-person -- --sandbox-root <path>\n')
}

function sandboxRootFromArgs(args) {
  if (args.length === 1 && args[0] === '--help') return null
  if (args.length !== 2 || args[0] !== '--sandbox-root' || !args[1].trim()) {
    throw new Error('IDENTITY_CLI_SANDBOX_ROOT_REQUIRED')
  }
  return args[1]
}

async function ask(prompt) {
  const reader = createInterface({ input: stdin, output: stdout, terminal: true })
  try {
    return await reader.question(prompt)
  } finally {
    reader.close()
  }
}

async function askHidden(prompt) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('IDENTITY_CLI_TTY_REQUIRED')
  stdout.write(prompt)
  return new Promise((resolveAnswer, rejectAnswer) => {
    let answer = ''
    const wasRaw = stdin.isRaw === true
    const restore = () => {
      stdin.off('data', onData)
      stdin.setRawMode(wasRaw)
      stdout.write('\n')
    }
    const fail = (error) => {
      restore()
      rejectAnswer(error)
    }
    const finish = () => {
      restore()
      resolveAnswer(answer)
    }
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          fail(new Error('IDENTITY_CLI_CANCELLED'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\b' || character === '\u007f') {
          answer = answer.slice(0, -1)
          continue
        }
        answer += character
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

async function main() {
  const sandboxRoot = sandboxRootFromArgs(process.argv.slice(2))
  if (sandboxRoot === null) {
    usage()
    return
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('IDENTITY_CLI_TTY_REQUIRED')

  const username = await ask('Username: ')
  const displayName = await ask('Display name: ')
  const relationship = await ask('Relationship (optional): ')
  const petAddressName = await ask('Pet address name (optional): ')
  const password = await askHidden('Password: ')
  const passwordConfirm = await askHidden('Confirm password: ')
  if (password !== passwordConfirm) throw new Error('IDENTITY_PASSWORD_CONFIRMATION_MISMATCH')

  const store = new IdentityStore(sandboxRoot)
  try {
    await store.initialize()
    const person = await store.createHouseholdPerson({
      username,
      displayName,
      relationship: relationship || null,
      petAddressName: petAddressName || null,
      password,
    })
    stdout.write('PERSON_CREATED\n')
    stdout.write(`PERSON_ID=${person.personId}\n`)
    stdout.write(`USERNAME=${person.username}\n`)
    stdout.write(`DISPLAY_NAME=${person.displayName}\n`)
  } finally {
    store.close()
  }
}

try {
  await main()
} catch (error) {
  const code = error?.code ?? error?.message ?? 'IDENTITY_CLI_FAILED'
  stdout.write(`IDENTITY_CREATE_FAILED=${code}\n`)
  process.exitCode = 1
}
