import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

export const PASSWORD_ALGORITHM = 'scrypt'
export const PASSWORD_PARAMS = Object.freeze({
  version: 1,
  N: 32768,
  r: 8,
  p: 1,
  keyLength: 64,
})

const PASSWORD_SALT_BYTES = 32
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024
export const SESSION_TOKEN_BYTES = 32
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const scrypt = promisify(scryptCallback)

function supportedParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { version, N, r, p, keyLength } = value
  if (version !== PASSWORD_PARAMS.version || N !== PASSWORD_PARAMS.N || r !== PASSWORD_PARAMS.r || p !== PASSWORD_PARAMS.p || keyLength !== PASSWORD_PARAMS.keyLength) return null
  return { version, N, r, p, keyLength }
}

function passwordOptions(params) {
  return {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAX_MEMORY,
  }
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  return value instanceof Uint8Array ? Buffer.from(value) : null
}

export function createPersonId() {
  return `person_${randomUUID().replaceAll('-', '')}`
}

export function createSessionToken() {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
}

export function hashSessionToken(token) {
  if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) return null
  return createHash('sha256').update(token, 'ascii').digest()
}

export async function hashPassword(password) {
  const params = { ...PASSWORD_PARAMS }
  const salt = randomBytes(PASSWORD_SALT_BYTES)
  const hash = Buffer.from(await scrypt(password, salt, params.keyLength, passwordOptions(params)))
  return {
    algorithm: PASSWORD_ALGORITHM,
    hash,
    salt,
    params: JSON.stringify(params),
  }
}

export async function verifyPasswordHash(password, credential) {
  if (typeof password !== 'string' || !credential || credential.passwordAlgorithm !== PASSWORD_ALGORITHM) return false
  const passwordHash = asBuffer(credential.passwordHash)
  const passwordSalt = asBuffer(credential.passwordSalt)
  if (!passwordHash || !passwordSalt) return false

  let parsedParams
  try {
    parsedParams = supportedParams(JSON.parse(credential.passwordParams))
  } catch {
    return false
  }
  if (!parsedParams || passwordHash.length !== parsedParams.keyLength) return false

  try {
    const candidate = Buffer.from(await scrypt(password, passwordSalt, parsedParams.keyLength, passwordOptions(parsedParams)))
    return candidate.length === passwordHash.length && timingSafeEqual(candidate, passwordHash)
  } catch {
    return false
  }
}
