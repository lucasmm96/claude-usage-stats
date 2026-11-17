// GET /api/sessions
// Reads sessions from Neon and returns in sessions.json format

const { initDb, initSchema } = require('./lib/db');
const { requireAuth } = require('./lib/auth');
const { handleCors } = require('./lib/cors');
const { readSessions } = require('./lib/read-handler');

const handler = handleCors(requireAuth(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sql = await initDb();

    // Initialize schema on first use (idempotent)
    await initSchema(sql);

    // Extract query parameters
    const { profile, since } = req.query;

    const startTime = Date.now();
    const result = await readSessions(sql, { profile, since });
    const duration = Date.now() - startTime;

    if (result.error) {
      return res.status(500).json({
        error: result.error,
      });
    }

    // Add metadata
    const response = {
      sessions: result.sessions,
      _meta: {
        queried_at: new Date().toISOString(),
        session_count: Object.keys(result.sessions).length,
        duration_ms: duration,
      },
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('[sessions] Unhandled error:', error.message);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}));

module.exports = handler;
