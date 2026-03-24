const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/auth');

// Track connected clients: Map<channelId, Set<{ws, userId, sessionId}>>
const channelClients = new Map();
// Track all connections by userId for presence
const userConnections = new Map();

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    // JWT is passed via query string (WebSocket does not support custom headers).
    // Ensure server/proxy logs do not capture full query strings in production.
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const channelId = url.searchParams.get('channel');
    const sessionToken = url.searchParams.get('session');

    // Authenticate
    let user;
    try {
      user = jwt.verify(token, JWT_SECRET);
    } catch {
      ws.close(4001, 'Invalid token');
      return;
    }

    // Verify channel membership (admins auto-join if not already a member)
    const memberCheck = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, user.id]
    );
    if (memberCheck.rows.length === 0) {
      if (user.role === 'admin') {
        await pool.query(
          'INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [channelId, user.id, 'admin']
        );
      } else {
        ws.close(4003, 'Not a member of this channel');
        return;
      }
    }

    // If session token provided, verify ownership and upsert session as connected
    if (sessionToken) {
      const existing = await pool.query('SELECT user_id FROM sessions WHERE session_token = $1', [sessionToken]);
      if (existing.rows.length > 0 && existing.rows[0].user_id !== user.id) {
        ws.close(4003, 'Session token belongs to another user');
        return;
      }
      await pool.query(
        `INSERT INTO sessions (session_token, user_id, channel_id, label, is_connected, connected_at)
         VALUES ($1, $2, $3, $4, true, NOW())
         ON CONFLICT (session_token) DO UPDATE SET is_connected = true, connected_at = NOW()`,
        [sessionToken, user.id, channelId, 'Claude Code Session']
      );
    }

    // Register client
    const clientInfo = { ws, userId: user.id, userName: user.name, sessionToken, channelId };

    if (!channelClients.has(channelId)) channelClients.set(channelId, new Set());
    channelClients.get(channelId).add(clientInfo);

    if (!userConnections.has(user.id)) userConnections.set(user.id, new Set());
    userConnections.get(user.id).add(clientInfo);

    // Update user last_seen
    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);

    // Only broadcast presence for Claude sessions (has session_token)
    // Browser connections are silent -- online status derived from userConnections
    if (sessionToken) {
      broadcastToChannel(channelId, {
        type: 'presence',
        user_id: user.id,
        user_name: user.name,
        session_token: sessionToken,
        status: 'connected',
      });
    }

    // Server-side ping to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
    }, 30000);

    // Handle incoming messages from WebSocket clients (browser UI)
    ws.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw);
        if (data.type === 'message') {
          if (!data.content || typeof data.content !== 'string') return;
          if (data.content.length > 10000) {
            ws.send(JSON.stringify({ type: 'error', error: 'Message too long (max 10000 characters)' }));
            return;
          }
          const validTypes = ['info', 'recommendation', 'status', 'system'];
          const messageType = validTypes.includes(data.message_type) ? data.message_type : 'info';

          const result = await pool.query(
            `INSERT INTO messages (channel_id, user_id, session_id, content, message_type, metadata)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [channelId, user.id, sessionToken || null, data.content, messageType, JSON.stringify(data.metadata || {})]
          );
          const message = result.rows[0];
          message.user_name = user.name;
          broadcastToChannel(channelId, { type: 'new_message', message });
        } else if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (err) {
        console.error('[ws] message error:', err);
        ws.send(JSON.stringify({ type: 'error', error: 'Failed to send message' }));
      }
    });

    ws.on('close', async () => {
      clearInterval(pingInterval);
      channelClients.get(channelId)?.delete(clientInfo);
      userConnections.get(user.id)?.delete(clientInfo);

      if (sessionToken) {
        await pool.query(
          'UPDATE sessions SET is_connected = false, disconnected_at = NOW() WHERE session_token = $1',
          [sessionToken]
        );

        broadcastToChannel(channelId, {
          type: 'presence',
          user_id: user.id,
          user_name: user.name,
          session_token: sessionToken,
          status: 'disconnected',
        });
      }
    });

    // Send connection confirmation with current online users for this channel
    const onlineUsers = {};
    const channelConns = channelClients.get(channelId);
    if (channelConns) {
      for (const conn of channelConns) {
        if (!onlineUsers[conn.userId]) {
          onlineUsers[conn.userId] = { user_id: conn.userId, user_name: conn.userName, session_token: conn.sessionToken };
        } else if (conn.sessionToken) {
          // Upgrade to show session_token if any connection has one
          onlineUsers[conn.userId].session_token = conn.sessionToken;
        }
      }
    }
    ws.send(JSON.stringify({
      type: 'connected',
      channel_id: channelId,
      user: { id: user.id, name: user.name },
      online: Object.values(onlineUsers),
    }));
  });

  return wss;
}

function broadcastToChannel(channelId, data) {
  const clients = channelClients.get(String(channelId));
  if (!clients) return;
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(payload);
    }
  }
}

function getPresence() {
  const presence = {};
  for (const [userId, connections] of userConnections) {
    const sessions = [];
    for (const conn of connections) {
      sessions.push({
        channel_id: conn.channelId,
        session_token: conn.sessionToken,
        is_claude_session: !!conn.sessionToken,
      });
    }
    if (sessions.length > 0) {
      presence[userId] = { user_name: [...connections][0]?.userName, sessions };
    }
  }
  return presence;
}

module.exports = { setupWebSocket, broadcastToChannel, getPresence };
