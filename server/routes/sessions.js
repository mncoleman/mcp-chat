const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');
const { broadcastToChannel } = require('../ws/index');
const { withChannelLabelLock, resolveLabel } = require('../lib/session-labels');

// Throttle per-session context-% writes: at most one DB write / broadcast per
// CONTEXT_MIN_INTERVAL_MS per session_token (the status-line wrapper may fire on
// every prompt render).
const lastContextWrite = new Map(); // session_token -> ms epoch
const CONTEXT_MIN_INTERVAL_MS = 5000;

// Periodically sweep stale throttle entries so the Map does not grow unbounded
// over a long-lived process (a new session_token is minted per connect). An entry
// older than the throttle window is safe to drop: the next write is already
// unthrottled regardless of whether the entry is present.
const CONTEXT_SWEEP_INTERVAL_MS = 60000;
const contextSweep = setInterval(() => {
  const cutoff = Date.now() - CONTEXT_MIN_INTERVAL_MS;
  for (const [token, ts] of lastContextWrite) {
    if (ts < cutoff) lastContextWrite.delete(token);
  }
}, CONTEXT_SWEEP_INTERVAL_MS);
// Do not keep the event loop alive solely for the sweep.
if (typeof contextSweep.unref === 'function') contextSweep.unref();

/**
 * POST /api/sessions - Register a new Claude Code session
 */
router.post('/', async (req, res) => {
  try {
    const { channel_id, label } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id is required' });

    // Verify membership
    const memberCheck = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channel_id, req.user.id]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this channel' });

    const sessionToken = uuidv4();
    const result = await pool.query(
      `INSERT INTO sessions (session_token, user_id, channel_id, label)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [sessionToken, req.user.id, channel_id, label || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[sessions]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/sessions - List active sessions for the current user
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, c.name as channel_name
       FROM sessions s
       JOIN channels c ON c.id = s.channel_id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[sessions]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/sessions/:id - Rename a session.
 * Any member of the session's channel can rename it; the new name is pushed
 * live to the session's MCP client so the session learns its own name.
 */
router.patch('/:id', async (req, res) => {
  try {
    const { label } = req.body;
    if (!label || typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'label is required' });
    }
    if (label.length > 100) return res.status(400).json({ error: 'Label too long (max 100 characters)' });

    const sessionResult = await pool.query('SELECT id, channel_id, session_token FROM sessions WHERE id = $1', [req.params.id]);
    if (sessionResult.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    const session = sessionResult.rows[0];

    // Verify caller is a member of the session's channel (admins allowed)
    const memberCheck = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [session.channel_id, req.user.id]
    );
    if (memberCheck.rows.length === 0 && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not a member of this channel' });
    }

    // Same per-channel uniqueness rule the MCP paths use -- a rename from the
    // browser sidebar must not be able to recreate a label collision either.
    const newLabel = await withChannelLabelLock(session.channel_id, async (client) => {
      const resolved = await resolveLabel(client, {
        channelId: session.channel_id,
        requested: label,
        excludeToken: session.session_token,
      });
      await client.query('UPDATE sessions SET label = $1 WHERE id = $2', [resolved.label, session.id]);
      return resolved.label;
    });

    broadcastToChannel(String(session.channel_id), {
      type: 'session_renamed',
      session_token: session.session_token,
      session_id: session.id,
      label: newLabel,
    });

    res.json({ id: session.id, label: newLabel });
  } catch (err) {
    console.error('[sessions]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/sessions/context - Report a session's live remaining-context %.
 * Called by the status-line wrapper (authenticated HTTP), NOT a model-invoked
 * tool. Ownership-guarded (mirrors rename_session), validated 0-100, throttled,
 * and broadcast as 'session_context_updated' so other sessions/browsers update.
 */
router.post('/context', async (req, res) => {
  try {
    const { session_token, pct } = req.body;
    if (!session_token) return res.status(400).json({ error: 'session_token is required' });
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'pct must be an integer 0-100' });
    }

    // Ownership: the session must exist and belong to the caller
    const sessionResult = await pool.query(
      'SELECT id, channel_id, user_id FROM sessions WHERE session_token = $1',
      [session_token]
    );
    if (sessionResult.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    const row = sessionResult.rows[0];
    if (row.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only report context for your own session' });
    }

    // Throttle: swallow writes that arrive too soon after the last one
    const now = Date.now();
    if (now - (lastContextWrite.get(session_token) || 0) < CONTEXT_MIN_INTERVAL_MS) {
      return res.json({ throttled: true });
    }
    lastContextWrite.set(session_token, now);

    await pool.query(
      'UPDATE sessions SET context_remaining_pct = $1 WHERE session_token = $2',
      [pct, session_token]
    );

    broadcastToChannel(String(row.channel_id), {
      type: 'session_context_updated',
      session_token,
      session_id: row.id,
      context_remaining_pct: pct,
    });

    res.json({ session_id: row.id, context_remaining_pct: pct });
  } catch (err) {
    console.error('[sessions]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/sessions/:id - Remove a session
 */
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ message: 'Session removed' });
  } catch (err) {
    console.error('[sessions]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
