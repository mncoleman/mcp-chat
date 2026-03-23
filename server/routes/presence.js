const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { getPresence } = require('../ws/index');

/**
 * GET /api/presence - Get online users in channels the requesting user belongs to
 */
router.get('/', async (req, res) => {
  try {
    const memberResult = await pool.query(
      'SELECT channel_id FROM channel_members WHERE user_id = $1',
      [req.user.id]
    );
    const myChannelIds = new Set(memberResult.rows.map(r => String(r.channel_id)));
    const allPresence = getPresence();

    // Filter to only show users in channels the requesting user is a member of
    const filtered = {};
    for (const [userId, data] of Object.entries(allPresence)) {
      const visibleSessions = data.sessions.filter(s => myChannelIds.has(String(s.channel_id)));
      if (visibleSessions.length > 0) {
        filtered[userId] = { ...data, sessions: visibleSessions };
      }
    }

    res.json(filtered);
  } catch (err) {
    console.error('[presence]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
