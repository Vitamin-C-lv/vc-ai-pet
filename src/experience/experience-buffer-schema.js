/**
 * The single on-disk schema contract for Experience Buffer.
 *
 * Schema version 1 was the originally committed 12-column table without a
 * metadata table. Version 2 is the additive upgrade that adds the six fields
 * used by the current runtime and records the version in experience_buffer_meta.
 */

export const EXPERIENCE_BUFFER_DB_FILENAME = 'experience-buffer.sqlite'
export const EXPERIENCE_BUFFER_SCHEMA_VERSION = 2
export const EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY = 'schema_version'
export const EXPERIENCE_BUFFER_TABLE = 'experience_events'
export const EXPERIENCE_BUFFER_META_TABLE = 'experience_buffer_meta'

/**
 * Frozen in creation order. The historical v1 contract had 12 columns; the
 * six current visual/session fields make the actual v2 table 18 columns.
 */
export const EXPERIENCE_EVENT_COLUMNS = Object.freeze([
  'id',
  'created_at',
  'source_type',
  'conversation_id',
  'conversation_key',
  'message_id',
  'actor_id',
  'content',
  'importance_score',
  'emotion_score',
  'memory_candidate',
  'vision_summary',
  'vision_id',
  'attachment_id',
  'visual_observation',
  'visual_focus',
  'processed',
  'processed_at',
])

const EVENT_COLUMN_DDL = Object.freeze({
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  created_at: 'INTEGER NOT NULL',
  source_type: 'TEXT NOT NULL',
  conversation_id: 'TEXT',
  conversation_key: 'TEXT',
  message_id: 'TEXT',
  actor_id: 'TEXT',
  content: 'TEXT NOT NULL',
  importance_score: 'REAL NOT NULL DEFAULT 0',
  emotion_score: 'REAL',
  memory_candidate: 'TEXT',
  vision_summary: 'TEXT',
  vision_id: 'TEXT',
  attachment_id: 'TEXT',
  visual_observation: 'TEXT',
  visual_focus: 'TEXT',
  processed: 'INTEGER NOT NULL DEFAULT 0',
  processed_at: 'INTEGER',
})

const INDEX_DDL = Object.freeze([
  `CREATE INDEX IF NOT EXISTS experience_events_created_at_idx ON ${EXPERIENCE_BUFFER_TABLE}(created_at);`,
  `CREATE INDEX IF NOT EXISTS experience_events_processed_id_idx ON ${EXPERIENCE_BUFFER_TABLE}(processed, id);`,
  `CREATE INDEX IF NOT EXISTS experience_events_source_type_idx ON ${EXPERIENCE_BUFFER_TABLE}(source_type);`,
  `CREATE INDEX IF NOT EXISTS experience_events_conversation_id_idx ON ${EXPERIENCE_BUFFER_TABLE}(conversation_id);`,
  `CREATE INDEX IF NOT EXISTS experience_events_conversation_key_idx ON ${EXPERIENCE_BUFFER_TABLE}(conversation_key);`,
])

/**
 * Return DDL only; this function has no database or filesystem side effects.
 */
export function experienceBufferSchemaDdl() {
  const columns = EXPERIENCE_EVENT_COLUMNS.map((name) => `    ${name.padEnd(18)} ${EVENT_COLUMN_DDL[name]}`)
  return Object.freeze({
    table: `CREATE TABLE IF NOT EXISTS ${EXPERIENCE_BUFFER_TABLE} (\n${columns.join(',\n')}\n  );`,
    indexes: [...INDEX_DDL],
    meta: `CREATE TABLE IF NOT EXISTS ${EXPERIENCE_BUFFER_META_TABLE} (\n  key TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);`,
    addableColumns: Object.freeze(EXPERIENCE_EVENT_COLUMNS
      .filter((name) => name !== 'id')
      .map((name) => Object.freeze({ name, definition: EVENT_COLUMN_DDL[name] }))),
  })
}

