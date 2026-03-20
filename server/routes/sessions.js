const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');

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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
