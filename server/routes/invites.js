const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

/**
 * POST /api/invites - Create an invite for an email (admin only)
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    // Check if email already has a pending invite
    const existing = await pool.query(
      'SELECT id FROM invites WHERE email = $1 AND used_by IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An active invite already exists for this email' });
    }

    // Check if user already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    const code = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const result = await pool.query(
      'INSERT INTO invites (code, email, created_by, expires_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [code, email, req.user.id, expiresAt]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[invites]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/invites - List all invites (admin only)
 */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, u1.name as created_by_name, u2.name as used_by_name
       FROM invites i
       LEFT JOIN users u1 ON u1.id = i.created_by
       LEFT JOIN users u2 ON u2.id = i.used_by
       ORDER BY i.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[invites]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
