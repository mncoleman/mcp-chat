const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/auth');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * POST /api/auth/google - Sign in with Google
 * First user auto-becomes admin with no invite needed.
 * Everyone else must have a matching email invite.
 */
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Check if user already exists
    const existingUser = await pool.query('SELECT * FROM users WHERE google_id = $1 OR email = $2', [googleId, email]);

    if (existingUser.rows.length > 0) {
      const user = existingUser.rows[0];

      if (!user.is_active) {
        return res.status(403).json({ error: 'Account is deactivated. Contact an admin.' });
      }

      // Update user info from Google
      await pool.query(
        'UPDATE users SET google_id = $1, name = $2, avatar_url = $3, last_seen_at = NOW(), updated_at = NOW() WHERE id = $4',
        [googleId, name, picture, user.id]
      );

      const token = jwt.sign(
        { id: user.id, email: user.email, name, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.json({
        token,
        user: { id: user.id, email: user.email, name, avatar_url: picture, role: user.role },
      });
    }

    // New user -- check if first user or has invite
    const countResult = await pool.query('SELECT COUNT(*) FROM users');
    const isFirstUser = parseInt(countResult.rows[0].count) === 0;

    let inviteId = null;
    if (!isFirstUser) {
      const inviteResult = await pool.query(
        'SELECT id FROM invites WHERE email = $1 AND used_by IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
        [email]
      );
      if (inviteResult.rows.length === 0) {
        return res.status(403).json({ error: 'No invite found for this email. Ask an admin to invite you.' });
      }
      inviteId = inviteResult.rows[0].id;
    }

    // Create user
    const result = await pool.query(
      `INSERT INTO users (google_id, email, name, avatar_url, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [googleId, email, name, picture, isFirstUser ? 'admin' : 'user']
    );

    const user = result.rows[0];

    // Mark invite as used
    if (inviteId) {
      await pool.query('UPDATE invites SET used_by = $1 WHERE id = $2', [user.id, inviteId]);
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, role: user.role },
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Invalid Google credential' });
  }
});

/**
 * GET /api/auth/me - Get current user
 */
router.get('/me', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    const result = await pool.query('SELECT id, email, name, avatar_url, role FROM users WHERE id = $1', [payload.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
