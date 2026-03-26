require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');

const { requireAuth } = require('./middleware/auth');
const { setupWebSocket, broadcastToChannel } = require('./ws/index');
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
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// Make broadcast available to route handlers
app.locals.broadcast = (channelId, data) => broadcastToChannel(String(channelId), data);

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
const MCP_CONNECT_LATEST = process.env.MCP_CONNECT_LATEST || '1.3.3';
app.get('/api/version', (req, res) => {
  res.json({ latest: MCP_CONNECT_LATEST });
});

// Auth (public)
app.use('/api/auth', require('./routes/auth'));

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
