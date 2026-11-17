// POST /api/ingest
// Receives full sessions.json and upserts to Neon

const { initDb, initSchema } = require('./lib/db');
const { requireAuth } = require('./lib/auth');
const { handleCors } = require('./lib/cors');
const { ingestSessions } = require('./lib/ingest-handler');

const handler = handleCors(requireAuth(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sql = await initDb();

    // Initialize schema on first use (idempotent)
    await initSchema(sql);

    // Parse and validate payload
    let payload;
    if (typeof req.body === 'string') {
      payload = JSON.parse(req.body);
    } else {
      payload = req.body;
    }

    const startTime = Date.now();
    const result = await ingestSessions(sql, payload);
    const duration = Date.now() - startTime;

    if (result.error) {
      return res.status(400).json({
        error: result.error,
        sessions_upserted: result.sessions_upserted,
        log_entries_inserted: result.log_entries_inserted,
      });
    }

    res.status(200).json({
      ok: result.ok,
      sessions_upserted: result.sessions_upserted,
      log_entries_inserted: result.log_entries_inserted,
      log_entries_skipped: result.log_entries_skipped,
      duration_ms: duration,
    });
  } catch (error) {
    console.error('[ingest] Unhandled error:', error.message);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}));

module.exports = handler;
