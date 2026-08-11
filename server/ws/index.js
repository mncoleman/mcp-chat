const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/auth');
const mentions = require('../lib/mentions');
const { collectMissed } = require('../lib/replay');

// Track connected clients: Map<channelId, Set<{ws, userId, sessionId}>>
const channelClients = new Map();
// Track all connections by userId for presence
const userConnections = new Map();

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
   try {
    // JWT is passed via query string (WebSocket does not support custom headers).
    // Ensure server/proxy logs do not capture full query strings in production.
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const channelId = url.searchParams.get('channel');
    const sessionToken = url.searchParams.get('session');
    // Optional client-tracked cursor: the highest message id this session has
    // already handled. More precise than the derived anchor and immune to
    // connected_at being restamped, so a client that tracks ids should send it.
    const sinceParam = url.searchParams.get('since');

    // Authenticate
    let user;
    try {
      user = jwt.verify(token, JWT_SECRET);
    } catch {
      ws.close(4001, 'Invalid token');
      return;
    }

    // Verify channel exists
    const channelCheck = await pool.query('SELECT is_private FROM channels WHERE id = $1', [channelId]);
    if (channelCheck.rows.length === 0) {
      ws.close(4003, 'Channel not found');
      return;
    }

    // Verify channel membership (admins auto-join public channels only; private
    // channels are invite-only and inaccessible even to admins who aren't members).
    const memberCheck = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, user.id]
    );
    if (memberCheck.rows.length === 0) {
      if (user.role === 'admin' && !channelCheck.rows[0].is_private) {
        await pool.query(
          'INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [channelId, user.id, 'admin']
        );
      } else {
        ws.close(4003, 'Not a member of this channel');
        return;
      }
    }

    // If session token provided, verify ownership and upsert session as connected.
    // The row is read BEFORE the upsert on purpose: the upsert stamps
    // connected_at = NOW(), which would move the replay anchor to this instant and
    // make every gap look empty. priorSession holds the pre-connect timestamps.
    let priorSession = null;
    if (sessionToken) {
      const existing = await pool.query(
        'SELECT user_id, created_at, connected_at, disconnected_at FROM sessions WHERE session_token = $1',
        [sessionToken]
      );
      if (existing.rows.length > 0 && existing.rows[0].user_id !== user.id) {
        ws.close(4003, 'Session token belongs to another user');
        return;
      }
      priorSession = existing.rows[0] || null;
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
          await deliverMessage(channelId, message);
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

    // Replay what this session missed while it had no socket open. Sessions only:
    // browsers load their own history over REST and would double-render it.
    // Membership was already enforced above at connection time -- do not re-check.
    if (sessionToken) {
      try {
        const missed = await collectMissed(pool, {
          channelId,
          sessionToken,
          sinceId: sinceParam,
          sessionRow: priorSession,
        });
        if (missed.count > 0 && ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'replay',
            channel_id: channelId,
            count: missed.count,
            from_id: missed.anchor_id,
            cursor: missed.cursor,
            truncated_by: missed.truncated_by,
            delivery_mode: missed.mode,
          }));
          // Each missed message is sent as an ordinary new_message frame tagged
          // replay:true, so a client needs no new handler -- it dedupes by id.
          for (const message of missed.messages) {
            if (ws.readyState !== 1) break;
            const mentioned = message.mentioned;
            delete message.mentioned;
            ws.send(JSON.stringify({ type: 'new_message', message, mentioned, replay: true }));
          }
        }
      } catch (err) {
        // Replay is best-effort: a failure here must not break the connection.
        console.error('[ws] replay failed:', err.message);
      }
    }
   } catch (err) {
    console.error('[ws] connection error:', err);
    try { ws.close(4000, 'Server error'); } catch {}
   }
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

// Mention resolution lives in server/lib/mentions.js so reconnect replay can reuse
// the exact same matching (and the same gate) without an N+1 label lookup. This
// wrapper keeps the original (channelId, content) signature for existing callers.
function resolveMentions(channelId, content) {
  return mentions.resolveMentions(pool, channelId, content);
}

// Deliver a new chat message to a channel, honoring its delivery mode. This is the
// single choke point all three send paths (browser WS, REST, MCP) route through.
//   'broadcast' -- every client receives it (unchanged legacy behavior).
//   'mention'   -- browser clients (no session token) always receive it; Claude
//                  sessions receive it only when their session is @-mentioned (that
//                  frame is tagged mentioned:true so the npm client can flag a direct
//                  ping). Un-mentioned sessions get nothing pushed and rely on mcp_chat_read.
async function deliverMessage(channelId, message) {
  const clients = channelClients.get(String(channelId));
  if (!clients || clients.size === 0) return;

  let mode = 'broadcast';
  try {
    const { rows } = await pool.query('SELECT delivery_mode FROM channels WHERE id = $1', [channelId]);
    if (rows[0]?.delivery_mode === 'mention') mode = 'mention';
  } catch (err) {
    console.error('[ws] deliverMessage mode lookup failed, defaulting to broadcast:', err.message);
  }

  if (mode === 'broadcast') {
    broadcastToChannel(channelId, { type: 'new_message', message });
    return;
  }

  const mentioned = await resolveMentions(channelId, message.content);
  const allPayload = JSON.stringify({ type: 'new_message', message });
  const mentionedPayload = JSON.stringify({ type: 'new_message', message, mentioned: true });
  for (const client of clients) {
    if (client.ws.readyState !== 1) continue;
    // Same gate reconnect replay uses (lib/mentions.isDeliverable) -- a session
    // must see on replay exactly what it would have seen live.
    if (!mentions.isDeliverable(mode, mentioned, client.sessionToken)) continue;
    // un-mentioned sessions are skipped by the gate (they can mcp_chat_read)
    if (!client.sessionToken) {
      client.ws.send(allPayload);                 // browser -- always live
    } else {
      client.ws.send(mentionedPayload);           // mentioned session -- direct ping
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

module.exports = { setupWebSocket, broadcastToChannel, deliverMessage, resolveMentions, getPresence };
