const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

/**
 * GET /api/channels - List channels the current user belongs to
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, cm.role as member_role,
        (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) as member_count
       FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
       WHERE c.is_archived = false
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/channels - Create a channel (admin only)
 */
router.post('/', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, member_ids } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    await client.query('BEGIN');

    const channelResult = await client.query(
      'INSERT INTO channels (name, description, created_by) VALUES ($1, $2, $3) RETURNING *',
      [name, description || null, req.user.id]
    );
    const channel = channelResult.rows[0];

    // Add creator as admin member
    await client.query(
      'INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3)',
      [channel.id, req.user.id, 'admin']
    );

    // Add additional members
    if (member_ids && member_ids.length > 0) {
      for (const userId of member_ids) {
        if (userId !== req.user.id) {
          await client.query(
            'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [channel.id, userId]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.status(201).json(channel);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/channels/:id - Get channel details with members
 */
router.get('/:id', async (req, res) => {
  try {
    // Verify membership
    const memberCheck = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this channel' });

    const channelResult = await pool.query('SELECT * FROM channels WHERE id = $1', [req.params.id]);
    if (channelResult.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });

    const membersResult = await pool.query(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.last_seen_at, cm.role
       FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = $1
       ORDER BY u.name`,
      [req.params.id]
    );

    const sessionsResult = await pool.query(
      `SELECT s.id, s.session_token, s.label, s.is_connected, s.connected_at, u.name as user_name, u.id as user_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.channel_id = $1 AND s.is_connected = true
       ORDER BY s.connected_at DESC`,
      [req.params.id]
    );

    res.json({
      ...channelResult.rows[0],
      members: membersResult.rows,
      active_sessions: sessionsResult.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/channels/:id/members - Add member to channel (admin only)
 */
router.post('/:id/members', requireAdmin, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    await pool.query(
      'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, user_id]
    );
    res.status(201).json({ message: 'Member added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/channels/:id/members/:userId - Remove member from channel (admin only)
 */
router.delete('/:id/members/:userId', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId]
    );
    res.json({ message: 'Member removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
