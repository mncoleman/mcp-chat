const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

/**
 * GET /api/channels/:channelId/messages - Get messages for a channel
 */
router.get('/:channelId/messages', async (req, res) => {
  try {
    // Verify membership
    const memberCheck = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [req.params.channelId, req.user.id]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this channel' });

    const { before, limit: limitRaw = '50' } = req.query;
    const parsedLimit = parseInt(limitRaw, 10);
    const params = [req.params.channelId, isNaN(parsedLimit) || parsedLimit < 1 ? 50 : Math.min(parsedLimit, 100)];
    let query = `
      SELECT m.*, u.name as user_name, u.avatar_url as user_avatar, s.label as session_label
      FROM messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN sessions s ON s.session_token = m.session_id
      WHERE m.channel_id = $1
    `;
    if (before) {
      const parsedBefore = parseInt(before, 10);
      if (isNaN(parsedBefore)) return res.status(400).json({ error: 'Invalid before parameter' });
      query += ' AND m.id < $3';
      params.push(parsedBefore);
    }
    query += ' ORDER BY m.created_at DESC LIMIT $2';

    const result = await pool.query(query, params);
    res.json(result.rows.reverse());
  } catch (err) {
    console.error('[messages]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/channels/:channelId/messages - Send a message
 */
router.post('/:channelId/messages', async (req, res) => {
  try {
    // Verify membership
    const memberCheck = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [req.params.channelId, req.user.id]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this channel' });

    const { content, message_type = 'info', session_id, metadata } = req.body;
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content is required' });
    if (content.length > 10000) return res.status(400).json({ error: 'Message too long (max 10000 characters)' });
    const validTypes = ['info', 'recommendation', 'status', 'system'];
    if (!validTypes.includes(message_type)) return res.status(400).json({ error: 'Invalid message_type' });

    const result = await pool.query(
      `INSERT INTO messages (channel_id, user_id, session_id, content, message_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.channelId, req.user.id, session_id || null, content, message_type, JSON.stringify(metadata || {})]
    );

    const message = result.rows[0];

    // Attach user info for broadcast
    message.user_name = req.user.name;

    // Broadcast via WebSocket (attached by server index)
    if (req.app.locals.broadcast) {
      req.app.locals.broadcast(req.params.channelId, {
        type: 'new_message',
        message,
      });
    }

    res.status(201).json(message);
  } catch (err) {
    console.error('[messages]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
