const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

/**
 * GET /api/users - List all users (admin only)
 */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, avatar_url, role, is_active, last_seen_at, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[users]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/users/:id/role - Update user role (admin only)
 */
router.put('/:id/role', requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or user' });
    }
    const result = await pool.query(
      'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, role',
      [role, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[users]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/users/:id/active - Activate/deactivate user (admin only)
 */
router.put('/:id/active', requireAdmin, async (req, res) => {
  try {
    const { is_active } = req.body;
    const result = await pool.query(
      'UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, is_active',
      [is_active, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[users]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/users/:id/service-key - Create a service account API key for a user (admin only)
 * Returns the plaintext key ONCE. It is stored as a SHA-256 hash.
 */
router.post('/:id/service-key', requireAdmin, async (req, res) => {
  try {
    const { label } = req.body;
    const userId = parseInt(req.params.id, 10);

    // Verify user exists
    const userResult = await pool.query('SELECT id, name FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    // Generate key
    const rawKey = `mcp_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 8);

    await pool.query(
      'INSERT INTO service_accounts (user_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4)',
      [userId, keyHash, keyPrefix, label || `Service key for ${userResult.rows[0].name}`]
    );

    // Return the plaintext key -- this is the only time it's shown
    res.status(201).json({
      api_key: rawKey,
      prefix: keyPrefix,
      label: label || `Service key for ${userResult.rows[0].name}`,
      warning: 'Save this key now. It cannot be retrieved again.',
    });
  } catch (err) {
    console.error('[users]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/users/:id/service-keys - List service account keys for a user (admin only)
 * Returns prefixes and metadata only, never the full key.
 */
router.get('/:id/service-keys', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, key_prefix, label, is_active, last_used_at, created_at FROM service_accounts WHERE user_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[users]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/users/:id/service-keys/:keyId - Revoke a service account key (admin only)
 */
router.delete('/:id/service-keys/:keyId', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE service_accounts SET is_active = false WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.keyId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Key not found' });
    res.json({ message: 'Key revoked' });
  } catch (err) {
    console.error('[users]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
