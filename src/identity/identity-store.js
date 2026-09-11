import { chmod, mkdir } from 'node:fs/promises'
import { relative, resolve, sep, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPersonId, hashPassword, verifyPasswordHash } from './identity-crypto.js'
import { IDENTITY_MIGRATIONS } from './identity-schema.js'

export const IDENTITY_DATABASE_FILENAME = 'identity.sqlite'

const ACCOUNT_TYPES = new Set(['household', 'guest'])
const PERSON_ID_PATTERN = /^[a-z0-9_-]{1,80}$/u
const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/iu

function identityError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function assertInside(root, target) {
  const relativeTarget = relative(root, target)
  if (relativeTarget === '' || (!relativeTarget.startsWith(`..${sep}`) && relativeTarget !== '..' && !relativeTarget.includes(`${sep}..${sep}`))) return target
  throw identityError('IDENTITY_DATABASE_PATH_INVALID')
}

function cleanPersonId(value) {
  const personId = String(value ?? '').trim()
  return PERSON_ID_PATTERN.test(personId) ? personId : null
}

function normalizeUsername(value) {
  const username = typeof value === 'string' ? value.trim() : ''
  if (!USERNAME_PATTERN.test(username)) throw identityError('IDENTITY_INVALID_USERNAME')
  return username.toLowerCase()
}

function requiredText(value, code, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < 1 || text.length > maxLength) throw identityError(code)
  return text
}

function optionalText(value, code, maxLength) {
  if (value === null || value === undefined || value === '') return null
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < 1 || text.length > maxLength) throw identityError(code)
  return text
}

function normalizeAvatarRef(value) {
  if (value === null || value === undefined || value === '') return null
  throw identityError('IDENTITY_INVALID_AVATAR_REF')
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256 || value.trim().length === 0) {
    throw identityError('IDENTITY_INVALID_PASSWORD')
  }
  return value
}

function safePerson(row) {
  if (!row) return null
  return {
    personId: row.person_id,
    accountType: row.account_type,
    username: row.username,
    displayName: row.display_name,
    relationship: row.relationship,
    petAddressName: row.pet_address_name,
    avatarRef: row.avatar_ref,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const PERSON_SELECT = `
  SELECT person_id, account_type, username, display_name, relationship,
         pet_address_name, avatar_ref, enabled, created_at, updated_at
  FROM people
`

export class IdentityStore {
  constructor(sandboxRoot, { now = () => Date.now(), idFactory = createPersonId } = {}) {
    if (!sandboxRoot) throw new TypeError('IDENTITY_SANDBOX_ROOT_REQUIRED')
    if (typeof now !== 'function') throw new TypeError('IDENTITY_CLOCK_INVALID')
    if (typeof idFactory !== 'function') throw new TypeError('IDENTITY_ID_FACTORY_INVALID')

    this.sandboxRoot = resolve(sandboxRoot)
    this.dbPath = assertInside(this.sandboxRoot, resolve(this.sandboxRoot, IDENTITY_DATABASE_FILENAME))
    this.now = now
    this.idFactory = idFactory
    this.db = null
    this.initialized = false
    this.initializing = null
  }

  async initialize() {
    if (this.initialized) return this
    if (this.initializing) return this.initializing

    this.initializing = (async () => {
      await mkdir(this.sandboxRoot, { recursive: true })
      const db = new DatabaseSync(this.dbPath)
      try {
        await chmod(this.dbPath, 0o600)
        db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;')
        db.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
          );
        `)
        db.exec('BEGIN IMMEDIATE')
        try {
          const applied = db.prepare('SELECT migration_id FROM schema_migrations WHERE migration_id = ?')
          const record = db.prepare('INSERT INTO schema_migrations(migration_id, applied_at) VALUES (?, ?)')
          for (const migration of IDENTITY_MIGRATIONS) {
            if (applied.get(migration.id)) continue
            db.exec(migration.sql)
            record.run(migration.id, this.now())
          }
          db.exec('COMMIT')
        } catch (error) {
          try { db.exec('ROLLBACK') } catch {}
          throw error
        }
        this.db = db
        this.initialized = true
        return this
      } catch (error) {
        db.close()
        throw error
      }
    })()

    try {
      return await this.initializing
    } finally {
      this.initializing = null
    }
  }

  close() {
    if (!this.db) return
    this.db.close()
    this.db = null
    this.initialized = false
  }

  async createHouseholdPerson({
    username,
    displayName,
    relationship = null,
    petAddressName = null,
    avatarRef = null,
    password,
  }) {
    await this.initialize()
    const normalizedUsername = normalizeUsername(username)
    const personId = cleanPersonId(this.idFactory())
    if (!personId) throw identityError('IDENTITY_PERSON_ID_INVALID')
    const person = {
      personId,
      username: normalizedUsername,
      displayName: requiredText(displayName, 'IDENTITY_INVALID_DISPLAY_NAME', 80),
      relationship: optionalText(relationship, 'IDENTITY_INVALID_RELATIONSHIP', 40),
      petAddressName: optionalText(petAddressName, 'IDENTITY_INVALID_PET_ADDRESS_NAME', 40),
      avatarRef: normalizeAvatarRef(avatarRef),
      password: validatePassword(password),
    }
    const credential = await hashPassword(person.password)
    const timestamp = this.now()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO people(
          person_id, account_type, username, display_name, relationship,
          pet_address_name, avatar_ref, enabled, created_at, updated_at
        ) VALUES (?, 'household', ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        person.personId,
        person.username,
        person.displayName,
        person.relationship,
        person.petAddressName,
        person.avatarRef,
        timestamp,
        timestamp,
      )
      this.db.prepare(`
        INSERT INTO credentials(
          person_id, password_algorithm, password_hash, password_salt,
          password_params, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        person.personId,
        credential.algorithm,
        credential.hash,
        credential.salt,
        credential.params,
        timestamp,
      )
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      if (String(error?.message ?? '').includes('people_household_username_uq')) throw identityError('IDENTITY_USERNAME_EXISTS')
      throw error
    }
    return this.personById(person.personId)
  }

  async personById(personId) {
    await this.initialize()
    const id = cleanPersonId(personId)
    if (!id) return null
    return safePerson(this.db.prepare(`${PERSON_SELECT} WHERE person_id = ?`).get(id))
  }

  async personByUsername(username) {
    await this.initialize()
    const value = typeof username === 'string' ? username.trim() : ''
    if (!value) return null
    return safePerson(this.db.prepare(`${PERSON_SELECT} WHERE lower(username) = lower(?)`).get(value))
  }

  async listPeople({ accountType = null, enabled = null } = {}) {
    await this.initialize()
    if (accountType !== null && !ACCOUNT_TYPES.has(accountType)) throw identityError('IDENTITY_INVALID_ACCOUNT_TYPE')
    if (enabled !== null && typeof enabled !== 'boolean') throw identityError('IDENTITY_INVALID_ENABLED_FILTER')
    const clauses = []
    const values = []
    if (accountType !== null) {
      clauses.push('account_type = ?')
      values.push(accountType)
    }
    if (enabled !== null) {
      clauses.push('enabled = ?')
      values.push(enabled ? 1 : 0)
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    return this.db.prepare(`${PERSON_SELECT}${where} ORDER BY display_name COLLATE NOCASE, person_id`).all(...values).map(safePerson)
  }

  async disablePerson(personId) {
    await this.initialize()
    const id = cleanPersonId(personId)
    if (!id) throw identityError('IDENTITY_PERSON_NOT_FOUND')
    const existing = this.db.prepare(`${PERSON_SELECT} WHERE person_id = ?`).get(id)
    if (!existing) throw identityError('IDENTITY_PERSON_NOT_FOUND')
    this.db.prepare('UPDATE people SET enabled = 0, updated_at = ? WHERE person_id = ?').run(this.now(), id)
    return this.personById(id)
  }

  async verifyPassword({ username, password }) {
    await this.initialize()
    const value = typeof username === 'string' ? username.trim() : ''
    if (!value || typeof password !== 'string') return { ok: false }
    const row = this.db.prepare(`
      SELECT p.person_id, p.account_type, p.username, p.display_name, p.relationship,
             p.pet_address_name, p.avatar_ref, p.enabled, p.created_at, p.updated_at,
             c.password_algorithm, c.password_hash, c.password_salt, c.password_params
      FROM people p
      LEFT JOIN credentials c ON c.person_id = p.person_id
      WHERE lower(p.username) = lower(?)
    `).get(value)
    if (!row || row.account_type !== 'household' || !row.enabled || !row.password_algorithm) return { ok: false }
    const valid = await verifyPasswordHash(password, {
      passwordAlgorithm: row.password_algorithm,
      passwordHash: row.password_hash,
      passwordSalt: row.password_salt,
      passwordParams: row.password_params,
    })
    return valid ? { ok: true, person: safePerson(row) } : { ok: false }
  }
}
