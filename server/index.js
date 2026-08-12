require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');

const { requireAuth } = require('./middleware/auth');
const { setupWebSocket } = require('./ws/index');
const { setupMcpRoutes } = require('./mcp/index');
const pool = require('./db/pool');

// Run migrations for new tables
pool.query(`
  CREATE TABLE IF NOT EXISTS service_accounts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'Service Account',
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).catch(err => console.error('Migration error:', err.message));

// Channel-wide instructions (shared system prompt seen by all connected sessions)
pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS instructions TEXT`)
  .catch(err => console.error('Migration error:', err.message));

// Per-channel delivery mode: 'broadcast' (push every message to every session) or
// 'mention' (only push to @<session-label>-mentioned sessions). Browsers always
// receive everything; mention-gating affects Claude-session push only.
pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'broadcast'`)
  .catch(err => console.error('Migration error:', err.message));

// Private channels: hidden from and inaccessible to non-members, INCLUDING admins
// (admins do not see them in listings and cannot auto-join). Default false keeps
// existing channels public with the legacy admin-sees-all behavior.
pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false`)
  .catch(err => console.error('Migration error:', err.message));

// Per-session live remaining-context %, self-reported by the status-line wrapper.
// 0-100, NULL = unknown. Nullable; no default.
pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS context_remaining_pct INTEGER`)
  .catch(err => console.error('Migration error:', err.message));

// Reply target. ON DELETE SET NULL rather than CASCADE: deleting a message must
// not silently take every answer to it with it. A reply whose parent is gone
// degrades to an ordinary message, which is why every read path LEFT JOINs the
// parent instead of requiring it.
//
// This has to run here, not in schema.sql. schema.sql is mounted at
// /docker-entrypoint-initdb.d and Postgres runs that ONLY on an empty data
// directory, so on the live database it never executes -- a column added only
// there would exist locally and be missing in production.
pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL`)
  .catch(err => console.error('Migration error:', err.message));

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173'];
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// Serve static client in production (before auth middleware)
const path = require('path');
const fs = require('fs');
const clientDist = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

// SPA fallback -- serve index.html for non-API routes (before auth)
if (fs.existsSync(clientDist)) {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/mcp') && !req.path.startsWith('/ws') && req.method === 'GET' && !req.path.includes('.')) {
      return res.sendFile(path.join(clientDist, 'index.html'));
    }
    next();
  });
}

// Public: latest mcp-chat-connect version (used by npm package for update checks)
const MCP_CONNECT_LATEST = process.env.MCP_CONNECT_LATEST || '1.11.0';
app.get('/api/version', (req, res) => {
  res.json({ latest: MCP_CONNECT_LATEST });
});

// Auth (public)
app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth/systematics', require('./routes/systematics-auth'));

// MCP endpoints (auth handled internally)
setupMcpRoutes(app);

// Protect all routes below with JWT
app.use(requireAuth);

// Routes
app.use('/api/users', require('./routes/users'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/channels', require('./routes/messages'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/presence', require('./routes/presence'));
app.use('/api/invites', require('./routes/invites'));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Set up WebSocket
setupWebSocket(server);

server.listen(PORT, () => {
  console.log(`MCP Chat server running on port ${PORT}`);
});
