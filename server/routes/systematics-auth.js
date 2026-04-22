const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/auth');

// jose is ESM-only; require()-ing it returns a Promise-wrapped module in Node 20.
// We cache the loaded module after the first call.
let josePromise = null;
function loadJose() {
  if (!josePromise) josePromise = import('jose');
  return josePromise;
}

const PKCE_COOKIE = 'sys_pkce';
const STATE_COOKIE = 'sys_state';

function siwsConfig() {
  const issuerUrl = process.env.SYSTEMATICS_ISSUER_URL;
  const clientId = process.env.SYSTEMATICS_CLIENT_ID;
  const clientSecret = process.env.SYSTEMATICS_CLIENT_SECRET;
  const redirectUri = process.env.SYSTEMATICS_REDIRECT_URI;
  if (!issuerUrl || !clientId || !clientSecret || !redirectUri) return null;
  return {
    issuerUrl: issuerUrl.replace(/\/$/, ''),
    clientId,
    clientSecret,
    redirectUri,
    scopes: process.env.SYSTEMATICS_SCOPES || 'openid profile email',
  };
}

function clientOrigin() {
  const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',');
  return allowed[0].trim().replace(/\/$/, '');
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Short-lived cookies only need to survive the round-trip to Systematics and back.
// SameSite=Lax lets the callback carry them on the top-level GET redirect.
const SHORT_COOKIE = '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600';
const CLEAR_COOKIE = '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

// GET /api/auth/systematics/config - tells the client whether to render the SIWS button.
router.get('/config', (req, res) => {
  res.json({ enabled: !!siwsConfig() });
});

// GET /api/auth/systematics/login - kick off the authorization code + PKCE flow.
router.get('/login', (req, res) => {
  const cfg = siwsConfig();
  if (!cfg) return res.status(501).send('Sign in with Systematics is not configured on this server');

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(24));

  const authorizeUrl = new URL(`${cfg.issuerUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', cfg.clientId);
  authorizeUrl.searchParams.set('redirect_uri', cfg.redirectUri);
  authorizeUrl.searchParams.set('scope', cfg.scopes);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  res.setHeader('Set-Cookie', [
    `${PKCE_COOKIE}=${verifier}${SHORT_COOKIE}`,
    `${STATE_COOKIE}=${state}${SHORT_COOKIE}`,
  ]);
  res.redirect(authorizeUrl.toString());
});

function redirectToLoginWithError(res, message) {
  const url = new URL(`${clientOrigin()}/login`);
  url.searchParams.set('error', message);
  res.redirect(url.toString());
}

// GET /api/auth/systematics/callback - exchange code, verify id_token, mint app JWT.
router.get('/callback', async (req, res) => {
  const cfg = siwsConfig();
  if (!cfg) return res.status(501).send('Sign in with Systematics is not configured');

  try {
    const { code, state, error } = req.query;
    if (error) return redirectToLoginWithError(res, String(error));
    if (!code || !state) return redirectToLoginWithError(res, 'Missing code or state');

    const cookieHeader = req.headers.cookie || '';
    const storedVerifier = parseCookie(cookieHeader, PKCE_COOKIE);
    const storedState = parseCookie(cookieHeader, STATE_COOKIE);
    if (!storedVerifier || !storedState) return redirectToLoginWithError(res, 'Session expired, please try again');
    if (state !== storedState) return redirectToLoginWithError(res, 'State mismatch');

    const tokenRes = await fetch(`${cfg.issuerUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: cfg.redirectUri,
        code_verifier: storedVerifier,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('[siws] token exchange failed:', text);
      return redirectToLoginWithError(res, 'Token exchange failed');
    }
    const tokens = await tokenRes.json();
    if (!tokens.id_token) return redirectToLoginWithError(res, 'No id_token from Systematics');

    const { createRemoteJWKSet, jwtVerify } = await loadJose();
    const jwks = createRemoteJWKSet(new URL(`${cfg.issuerUrl}/.well-known/jwks.json`));
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: cfg.issuerUrl,
      audience: cfg.clientId,
    });

    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const name = typeof payload.name === 'string' ? payload.name : email;
    const picture = typeof payload.picture === 'string' ? payload.picture : null;
    if (!email) return redirectToLoginWithError(res, 'Systematics did not return an email');

    // Mirror the Google flow: existing user by email logs in; new user needs an invite
    // unless they are the very first user.
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user;
    if (existing.rows.length > 0) {
      user = existing.rows[0];
      if (!user.is_active) return redirectToLoginWithError(res, 'Account is deactivated');
      await pool.query(
        'UPDATE users SET name = $1, avatar_url = COALESCE($2, avatar_url), last_seen_at = NOW(), updated_at = NOW() WHERE id = $3',
        [name, picture, user.id],
      );
    } else {
      const countResult = await pool.query('SELECT COUNT(*) FROM users');
      const isFirstUser = parseInt(countResult.rows[0].count, 10) === 0;

      let inviteId = null;
      if (!isFirstUser) {
        const inviteResult = await pool.query(
          'SELECT id FROM invites WHERE email = $1 AND used_by IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
          [email],
        );
        if (inviteResult.rows.length === 0) {
          return redirectToLoginWithError(res, 'No invite found for this email. Ask an admin to invite you.');
        }
        inviteId = inviteResult.rows[0].id;
      }

      const insertResult = await pool.query(
        `INSERT INTO users (email, name, avatar_url, role)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [email, name, picture, isFirstUser ? 'admin' : 'user'],
      );
      user = insertResult.rows[0];
      if (inviteId) {
        await pool.query('UPDATE invites SET used_by = $1 WHERE id = $2', [user.id, inviteId]);
      }
    }

    const appToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' },
    );

    const handoffUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
      role: user.role,
    };

    const completeUrl = new URL(`${clientOrigin()}/auth/systematics/complete`);
    completeUrl.hash = new URLSearchParams({
      token: appToken,
      user: base64url(Buffer.from(JSON.stringify(handoffUser), 'utf8')),
    }).toString();

    res.setHeader('Set-Cookie', [
      `${PKCE_COOKIE}=${CLEAR_COOKIE}`,
      `${STATE_COOKIE}=${CLEAR_COOKIE}`,
    ]);
    res.redirect(completeUrl.toString());
  } catch (err) {
    console.error('[siws] callback error:', err);
    redirectToLoginWithError(res, 'Sign in with Systematics failed');
  }
});

module.exports = router;
