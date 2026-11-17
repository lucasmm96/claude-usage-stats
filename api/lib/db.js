// Neon serverless client initialization
// Uses HTTP pooling for optimal performance in serverless environments

const { neon } = require('@neondatabase/serverless');

let sqlInstance = null;

async function initDb() {
  if (sqlInstance) return sqlInstance;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable not set');
  }

  sqlInstance = neon(databaseUrl, { arrayMode: false });
  return sqlInstance;
}

// Schema initialization (idempotent) — separate queries for compatibility
async function initSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    session_name TEXT,
    model TEXT,
    profile TEXT,
    started_at TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ,
    state JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS log_entries (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL,
    event TEXT,
    input_tokens INT,
    cache_read_tokens INT,
    cache_write_tokens INT,
    output_tokens INT,
    context_pct INT
  )`;

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_log_unique ON log_entries (session_id, at, COALESCE(event, ''))`;
  await sql`CREATE INDEX IF NOT EXISTS idx_log_session ON log_entries (session_id, at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions (profile) WHERE profile IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions (last_activity_at DESC)`;

  // Cleanup: the unused log_errors table was removed; drop it from existing deployments
  await sql`DROP TABLE IF EXISTS log_errors`;

  // Migration: add model column to log_entries (idempotent)
  await sql`ALTER TABLE log_entries ADD COLUMN IF NOT EXISTS model TEXT`;
}

module.exports = { initDb, initSchema };
