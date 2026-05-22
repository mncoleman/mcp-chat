const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');
const { broadcastToChannel } = require('../ws/index');

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

    const newLabel = label.trim();
    await pool.query('UPDATE sessions SET label = $1 WHERE id = $2', [newLabel, session.id]);

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
