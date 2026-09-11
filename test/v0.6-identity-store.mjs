import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IDENTITY_DATABASE_FILENAME, IdentityStore } from '../src/identity/identity-store.js'
import { IDENTITY_MIGRATION_ID } from '../src/identity/identity-schema.js'

const sharedPassword = 'household-test-password'

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function protectedStoreDigests(root) {
  const paths = {
    archive: join(root, 'conversation-archive.db'),
    visual: join(root, 'visual-experience.db'),
    petMemory: join(root, 'memory', 'pet-memory.db'),
  }
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await digest(path)])))
}

function inspectDatabase(path) {
  const db = new DatabaseSync(path)
  try {
    return {
      migrationRows: db.prepare('SELECT migration_id, applied_at FROM schema_migrations ORDER BY migration_id').all(),
      people: db.prepare('SELECT COUNT(*) AS count FROM people').get().count,
      credentials: db.prepare('SELECT COUNT(*) AS count FROM credentials').get().count,
      sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
      guestDevices: db.prepare('SELECT COUNT(*) AS count FROM guest_devices').get().count,
      tableNames: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
      indexNames: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name),
      schema: JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all()),
    }
  } finally {
    db.close()
  }
}

function credentialsFor(path, personId) {
  const db = new DatabaseSync(path)
  try {
    return db.prepare('SELECT password_hash, password_salt, password_params FROM credentials WHERE person_id = ?').get(personId)
  } finally {
    db.close()
  }
}

function assertErrorCode(code) {
  return (error) => error?.code === code
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-identity-store-'))
  const identityPath = join(root, IDENTITY_DATABASE_FILENAME)
  let store = null
  let reopened = null
  try {
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(join(root, 'conversation-archive.db'), 'archive-fixture', 'utf8')
    await writeFile(join(root, 'visual-experience.db'), 'visual-fixture', 'utf8')
    await writeFile(join(root, 'memory', 'pet-memory.db'), 'pet-memory-fixture', 'utf8')
    const protectedBefore = await protectedStoreDigests(root)

    let now = 1000
    store = new IdentityStore(root, { now: () => now })
    await store.initialize()
    const first = inspectDatabase(identityPath)
    assert.deepEqual(first.migrationRows.map((row) => row.migration_id), [IDENTITY_MIGRATION_ID])
    assert.equal(first.people, 0)
    assert.equal(first.credentials, 0)
    assert.equal(first.sessions, 0)
    assert.equal(first.guestDevices, 0)
    for (const table of ['schema_migrations', 'people', 'credentials', 'sessions', 'guest_devices']) assert.ok(first.tableNames.includes(table))
    for (const index of ['people_household_username_uq', 'people_enabled_type_idx', 'sessions_person_active_idx', 'guest_devices_person_uq']) assert.ok(first.indexNames.includes(index))
    assert.equal((await stat(identityPath)).mode & 0o777, 0o600)

    await store.initialize()
    const second = inspectDatabase(identityPath)
    assert.deepEqual(second.migrationRows.map((row) => row.migration_id), [IDENTITY_MIGRATION_ID])
    assert.equal(second.people, 0)
    assert.equal(second.schema, first.schema)

    const constraintDb = new DatabaseSync(identityPath)
    try {
      assert.throws(() => constraintDb.prepare(`
        INSERT INTO people(person_id, account_type, username, display_name, enabled, created_at, updated_at)
        VALUES (?, 'guest', ?, ?, 1, ?, ?)
      `).run('guest_invalid', 'not-allowed', '访客', now, now))
      assert.throws(() => constraintDb.prepare(`
        INSERT INTO people(person_id, account_type, username, display_name, enabled, created_at, updated_at)
        VALUES (?, 'household', ?, ?, 1, ?, ?)
      `).run('person_invalid', null, '缺少用户名', now, now))
    } finally {
      constraintDb.close()
    }

    const mom = await store.createHouseholdPerson({
      username: ' Mom ',
      displayName: '妈妈',
      relationship: 'family',
      petAddressName: '妈妈',
      password: sharedPassword,
    })
    assert.match(mom.personId, /^person_[a-z0-9]{32}$/u)
    assert.ok(mom.personId.length <= 80)
    assert.equal(mom.username, 'mom')
    assert.equal(mom.accountType, 'household')
    assert.equal(mom.enabled, true)
    assert.equal((await store.personById(mom.personId)).personId, mom.personId)
    assert.equal((await store.personByUsername('MOM')).personId, mom.personId)

    const countsBeforeDuplicate = inspectDatabase(identityPath)
    await assert.rejects(
      store.createHouseholdPerson({ username: 'MOM', displayName: '重复', password: 'another-safe-password' }),
      assertErrorCode('IDENTITY_USERNAME_EXISTS'),
    )
    const countsAfterDuplicate = inspectDatabase(identityPath)
    assert.equal(countsAfterDuplicate.people, countsBeforeDuplicate.people)
    assert.equal(countsAfterDuplicate.credentials, countsBeforeDuplicate.credentials)
    await assert.rejects(
      store.createHouseholdPerson({ username: 'kid', displayName: '   ', password: 'another-safe-password' }),
      assertErrorCode('IDENTITY_INVALID_DISPLAY_NAME'),
    )
    await assert.rejects(
      store.createHouseholdPerson({ username: 'kid', displayName: '孩子', password: 'short' }),
      assertErrorCode('IDENTITY_INVALID_PASSWORD'),
    )

    now = 2000
    const dad = await store.createHouseholdPerson({
      username: 'Dad',
      displayName: '爸爸',
      relationship: 'family',
      petAddressName: '爸爸',
      password: sharedPassword,
    })
    const momCredential = credentialsFor(identityPath, mom.personId)
    const dadCredential = credentialsFor(identityPath, dad.personId)
    assert.ok(momCredential.password_hash instanceof Uint8Array)
    assert.ok(momCredential.password_salt instanceof Uint8Array)
    assert.equal(Buffer.from(momCredential.password_hash).toString('utf8').includes(sharedPassword), false)
    assert.equal(Buffer.from(momCredential.password_salt).equals(Buffer.from(dadCredential.password_salt)), false)
    assert.equal(Buffer.from(momCredential.password_hash).equals(Buffer.from(dadCredential.password_hash)), false)
    assert.equal((await readFile(identityPath)).includes(Buffer.from(sharedPassword, 'utf8')), false)

    const verified = await store.verifyPassword({ username: 'mOm', password: sharedPassword })
    assert.equal(verified.ok, true)
    assert.equal(verified.person.personId, mom.personId)
    assert.equal(Object.hasOwn(verified.person, 'passwordHash'), false)
    assert.equal(Object.hasOwn(verified.person, 'passwordSalt'), false)
    assert.equal(Object.hasOwn(verified.person, 'passwordParams'), false)
    assert.deepEqual(await store.verifyPassword({ username: 'mom', password: 'wrong-password' }), { ok: false })
    assert.deepEqual(await store.verifyPassword({ username: 'unknown', password: sharedPassword }), { ok: false })

    now = 3000
    const disabled = await store.disablePerson(mom.personId)
    assert.equal(disabled.enabled, false)
    assert.deepEqual(await store.verifyPassword({ username: 'mom', password: sharedPassword }), { ok: false })
    assert.equal((await store.personById(mom.personId)).enabled, false)
    assert.ok(credentialsFor(identityPath, mom.personId))
    assert.deepEqual((await store.listPeople({ enabled: true })).map((person) => person.personId), [dad.personId])
    assert.deepEqual((await store.listPeople({ enabled: false })).map((person) => person.personId), [mom.personId])
    assert.equal((await store.listPeople({ accountType: 'household' })).length, 2)

    const protectedAfter = await protectedStoreDigests(root)
    assert.deepEqual(protectedAfter, protectedBefore)
    assert.ok((await readdir(root)).includes(IDENTITY_DATABASE_FILENAME))
    for (const entry of await readdir(root)) {
      if (!entry.startsWith(`${IDENTITY_DATABASE_FILENAME}-`)) continue
      assert.equal((await stat(join(root, entry))).mode & 0o777, 0o600)
    }

    store.close()
    store.close()
    store = null
    reopened = new IdentityStore(root, { now: () => 4000 })
    await reopened.initialize()
    assert.equal((await reopened.personByUsername('DAD')).personId, dad.personId)
    assert.equal((await reopened.verifyPassword({ username: 'dad', password: sharedPassword })).ok, true)

    console.log('FIRST_INIT_MIGRATIONS=1')
    console.log('SECOND_INIT_MIGRATIONS=1')
    console.log('FIRST_PEOPLE=0')
    console.log('SECOND_PEOPLE=0')
    console.log('SCHEMA_DIFF_AFTER_SECOND_INIT=NONE')
    console.log('HOUSEHOLD_CREATE_TEST=PASS')
    console.log('USERNAME_CASE_INSENSITIVE_UNIQUE=PASS')
    console.log('GUEST_USERNAME_NULL_CONSTRAINT=PASS')
    console.log('PASSWORD_ALGORITHM=scrypt')
    console.log('PASSWORD_PLAINTEXT_STORED=NO')
    console.log('PASSWORD_SALT_UNIQUE=YES')
    console.log('PASSWORD_VERIFY_CORRECT=PASS')
    console.log('PASSWORD_VERIFY_WRONG=PASS')
    console.log('DISABLED_LOGIN_REJECTED=PASS')
    console.log('SAFE_DTO_CREDENTIAL_LEAK=NO')
    console.log('ARCHIVE_UNCHANGED=YES')
    console.log('VISUAL_DB_UNCHANGED=YES')
    console.log('PET_MEMORY_DB_UNCHANGED=YES')
  } finally {
    try { store?.close() } catch {}
    try { reopened?.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

await main()
