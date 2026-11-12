// GET /api/sessions handler logic
// Reads from Neon and reconstructs sessions.json format

async function readSessions(sql, query = {}) {
  const { profile, since } = query;

  try {
    // Fetch all sessions with their log entries
    const results = await sql`
      SELECT
        s.session_id,
        s.session_name,
        s.model,
        s.profile,
        s.started_at,
        s.last_activity_at,
        s.state,
        json_agg(
          json_build_object(
            'at', le.at,
            'event', le.event,
            'input_tokens', le.input_tokens,
            'cache_read_tokens', le.cache_read_tokens,
            'cache_write_tokens', le.cache_write_tokens,
            'output_tokens', le.output_tokens,
            'context_pct', le.context_pct,
            'model', le.model
          )
          ORDER BY le.at ASC
        ) FILTER (WHERE le.id IS NOT NULL) as log
      FROM sessions s
      LEFT JOIN log_entries le ON s.session_id = le.session_id
      ${profile ? sql`WHERE s.profile = ${profile}` : sql``}
      ${profile && since ? sql`AND s.last_activity_at >= ${since}` : !profile && since ? sql`WHERE s.last_activity_at >= ${since}` : sql``}
      GROUP BY s.session_id, s.session_name, s.model, s.profile,
               s.started_at, s.last_activity_at, s.state
      ORDER BY s.last_activity_at DESC
    `;

    // Reconstruct sessions.json format. Optional columns are always emitted,
    // with explicit nulls when unset — same shape the hook script writes
    // locally (docs/log-format.md), so an export can round-trip byte-exact.
    const sessions = {};
    for (const row of results) {
      const sess = {
        session_id: row.session_id,
        session_name: row.session_name,
        profile: row.profile,
        model: row.model,
        started_at: row.started_at,
        last_activity_at: row.last_activity_at,
      };

      if (row.state) {
        try {
          sess._state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
        } catch (e) {
          console.error(`[read] Failed to parse _state for ${row.session_id}:`, e.message);
        }
      }

      if (row.log && Array.isArray(row.log)) {
        sess.log = row.log
          .filter(entry => entry && entry.at)
          .map(entry => ({
            at: entry.at,
            ...(entry.event && { event: entry.event }),
            ...(entry.input_tokens !== null && { input_tokens: entry.input_tokens }),
            ...(entry.cache_read_tokens !== null && { cache_read_tokens: entry.cache_read_tokens }),
            ...(entry.cache_write_tokens !== null && { cache_write_tokens: entry.cache_write_tokens }),
            ...(entry.output_tokens !== null && { output_tokens: entry.output_tokens }),
            ...(entry.context_pct !== null && { context_pct: entry.context_pct }),
            ...(entry.model != null && { model: entry.model }),
          }));
      } else {
        sess.log = [];
      }

      sessions[row.session_id] = sess;
    }

    return { ok: true, sessions };
  } catch (error) {
    console.error('[read] Query failed:', error.message);
    return { error: `Database error: ${error.message}` };
  }
}

module.exports = { readSessions };
