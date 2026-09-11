export const IDENTITY_MIGRATION_ID = 'identity.001'

export const IDENTITY_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: IDENTITY_MIGRATION_ID,
    sql: `
      CREATE TABLE people (
        person_id TEXT PRIMARY KEY,
        account_type TEXT NOT NULL CHECK (account_type IN ('household', 'guest')),
        username TEXT,
        display_name TEXT NOT NULL,
        relationship TEXT,
        pet_address_name TEXT,
        avatar_ref TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (account_type = 'household' AND username IS NOT NULL)
          OR (account_type = 'guest' AND username IS NULL)
        )
      );

      CREATE UNIQUE INDEX people_household_username_uq
        ON people(lower(username))
        WHERE username IS NOT NULL;

      CREATE INDEX people_enabled_type_idx
        ON people(account_type, enabled, display_name);

      CREATE TABLE credentials (
        person_id TEXT PRIMARY KEY REFERENCES people(person_id) ON DELETE CASCADE,
        password_algorithm TEXT NOT NULL CHECK (password_algorithm = 'scrypt'),
        password_hash BLOB NOT NULL,
        password_salt BLOB NOT NULL,
        password_params TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        session_id_hash BLOB PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE INDEX sessions_person_active_idx
        ON sessions(person_id, revoked_at, expires_at);

      CREATE TABLE guest_devices (
        device_key_hash BLOB PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX guest_devices_person_uq
        ON guest_devices(person_id);
    `,
  }),
])
