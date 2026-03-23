const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/auth');
const { broadcastToChannel } = require('../ws/index');

/**
 * MCP Server endpoint using SSE for server-to-client push
 * and JSON-RPC style tool calls from client-to-server.
 *
 * Claude Code connects to: GET /mcp/sse?token=JWT&channel=ID
 * Claude Code calls tools: POST /mcp/call
 */

// Track SSE clients for push
const sseClients = new Map(); // sessionToken -> { res, userId, channelId }

function setupMcpRoutes(app) {
  /**
   * SSE endpoint - Claude Code sessions connect here to receive pushed messages
   */
  app.get('/mcp/sse', async (req, res) => {
    const { token, channel, label } = req.query;

    // Authenticate
    let user;
    try {
      user = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const channelId = channel;

    // Verify membership
    const memberCheck = await pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, user.id]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this channel' });
    }

    // Create session record
    const sessionToken = uuidv4();
    await pool.query(
      `INSERT INTO sessions (session_token, user_id, channel_id, label, is_connected, connected_at)
       VALUES ($1, $2, $3, $4, true, NOW())`,
      [sessionToken, user.id, channelId, label || 'Claude Code Session']
    );

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Session-Token': sessionToken,
    });

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', session_token: sessionToken, channel_id: channelId })}\n\n`);

    // Register for push
    sseClients.set(sessionToken, { res, userId: user.id, channelId, userName: user.name });

    // Broadcast presence
    broadcastToChannel(String(channelId), {
      type: 'presence',
      user_id: user.id,
      user_name: user.name,
      session_token: sessionToken,
      status: 'connected',
    });

    // Keepalive
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);

    // Cleanup on disconnect
    req.on('close', async () => {
      clearInterval(keepalive);
      sseClients.delete(sessionToken);

      await pool.query(
        'UPDATE sessions SET is_connected = false, disconnected_at = NOW() WHERE session_token = $1',
        [sessionToken]
      );

      broadcastToChannel(String(channelId), {
        type: 'presence',
        user_id: user.id,
        user_name: user.name,
        session_token: sessionToken,
        status: 'disconnected',
      });
    });
  });

  /**
   * Tool call endpoint - Claude Code calls this to send messages, list channels, etc.
   */
  app.post('/mcp/call', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing token' });
    }

    let user;
    try {
      user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { tool, args } = req.body;

    try {
      switch (tool) {
        case 'send_message': {
          const { channel_id, content, message_type = 'info', session_token } = args;
          if (!channel_id || !content) {
            return res.json({ error: 'channel_id and content are required' });
          }

          // Verify channel membership
          const sendMemberCheck = await pool.query(
            'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
            [channel_id, user.id]
          );
          if (sendMemberCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Not a member of this channel' });
          }

          const result = await pool.query(
            `INSERT INTO messages (channel_id, user_id, session_id, content, message_type)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [channel_id, user.id, session_token || null, content, message_type]
          );
          const message = result.rows[0];
          message.user_name = user.name;

          // Broadcast to WebSocket clients (browser UI)
          broadcastToChannel(String(channel_id), { type: 'new_message', message });

          // Push to SSE clients (other Claude Code sessions)
          pushToChannel(channel_id, session_token, { type: 'new_message', message });

          return res.json({ success: true, message_id: message.id });
        }

        case 'list_channels': {
          const result = await pool.query(
            `SELECT c.id, c.name, c.description
             FROM channels c
             JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
             WHERE c.is_archived = false`,
            [user.id]
          );
          return res.json({ channels: result.rows });
        }

        case 'get_messages': {
          const { channel_id, limit = 20 } = args;

          // Verify channel membership
          const msgMemberCheck = await pool.query(
            'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
            [channel_id, user.id]
          );
          if (msgMemberCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Not a member of this channel' });
          }

          const result = await pool.query(
            `SELECT m.id, m.content, m.message_type, m.session_id, m.created_at, u.name as user_name
             FROM messages m JOIN users u ON u.id = m.user_id
             WHERE m.channel_id = $1
             ORDER BY m.created_at DESC LIMIT $2`,
            [channel_id, Math.min(parseInt(limit), 100)]
          );
          return res.json({ messages: result.rows.reverse() });
        }

        case 'get_presence': {
          const { channel_id } = args;

          // Verify channel membership
          const presMemberCheck = await pool.query(
            'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
            [channel_id, user.id]
          );
          if (presMemberCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Not a member of this channel' });
          }

          const result = await pool.query(
            `SELECT s.session_token, s.label, s.is_connected, u.name as user_name, u.id as user_id
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.channel_id = $1 AND s.is_connected = true`,
            [channel_id]
          );
          return res.json({ sessions: result.rows });
        }

        default:
          return res.json({ error: `Unknown tool: ${tool}` });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * MCP tool manifest - describes available tools for Claude Code
   */
  app.get('/mcp/manifest', (req, res) => {
    res.json({
      name: 'mcp-chat',
      version: '1.0.0',
      description: 'Real-time team messaging for Claude Code sessions',
      tools: [
        {
          name: 'send_message',
          description: 'Send a message to a channel. Messages are informational or recommendations, not direct orders.',
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: { type: 'number', description: 'Channel ID to send to' },
              content: { type: 'string', description: 'Message content' },
              message_type: { type: 'string', enum: ['info', 'recommendation', 'status'], description: 'Type of message (default: info)' },
              session_token: { type: 'string', description: 'Your session token (for sender identification)' },
            },
            required: ['channel_id', 'content'],
          },
        },
        {
          name: 'list_channels',
          description: 'List all channels you are a member of',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_messages',
          description: 'Get recent messages from a channel for context',
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: { type: 'number', description: 'Channel ID' },
              limit: { type: 'number', description: 'Number of messages (max 100, default 20)' },
            },
            required: ['channel_id'],
          },
        },
        {
          name: 'get_presence',
          description: 'See who is online and which Claude Code sessions are active in a channel',
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: { type: 'number', description: 'Channel ID' },
            },
            required: ['channel_id'],
          },
        },
      ],
    });
  });
}

/**
 * Push a message to all SSE-connected Claude Code sessions in a channel
 * (excluding the sender's session)
 */
function pushToChannel(channelId, excludeSessionToken, data) {
  for (const [token, client] of sseClients) {
    if (String(client.channelId) === String(channelId) && token !== excludeSessionToken) {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }
}

module.exports = { setupMcpRoutes };
