require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');

const { requireAuth } = require('./middleware/auth');
const { setupWebSocket, broadcastToChannel } = require('./ws/index');
const { setupMcpRoutes } = require('./mcp/index');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Auth (public)
app.use('/api/auth', require('./routes/auth'));

// Invite validation is public (so registration page can check)
const invitesRouter = require('./routes/invites');
app.get('/api/invites/validate/:code', invitesRouter);

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
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
});
