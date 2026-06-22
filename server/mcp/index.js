const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/auth');
const { broadcastToChannel, deliverMessage, resolveMentions } = require('../ws/index');

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

    // Verify membership (admins auto-join if not already a member)
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
        return res.status(403).json({ error: 'Not a member of this channel' });
      }
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
          const { channel_id, content, session_token } = args;
          if (!channel_id || !content || typeof content !== 'string') {
            return res.json({ error: 'channel_id and content (string) are required' });
          }
          if (content.length > 10000) {
            return res.json({ error: 'Message too long (max 10000 characters)' });
          }
          const validTypes = ['info', 'recommendation', 'status', 'system'];
          const message_type = validTypes.includes(args.message_type) ? args.message_type : 'info';

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

          // Attach the sender session's label so live messages show which session sent them
          if (session_token) {
            const labelResult = await pool.query(
              'SELECT label FROM sessions WHERE session_token = $1',
              [session_token]
            );
            message.session_label = labelResult.rows[0]?.label || null;
          }

          // Deliver to WebSocket clients (browsers + Claude sessions), honoring the
          // channel's delivery mode (broadcast to all, or only @-mentioned sessions).
          await deliverMessage(channel_id, message);

          // Legacy SSE fan-out to any SSE-connected sessions. The live npm client
          // receives over WebSocket, but keep SSE consistent: in mention mode only
          // push to @-mentioned sessions; otherwise to all (excluding the sender).
          let sseAllowed = null;
          const channelMode = await pool.query('SELECT delivery_mode FROM channels WHERE id = $1', [channel_id]);
          if (channelMode.rows[0]?.delivery_mode === 'mention') {
            sseAllowed = await resolveMentions(channel_id, content);
          }
          pushToChannel(channel_id, session_token, { type: 'new_message', message }, sseAllowed);

          return res.json({ success: true, message_id: message.id });
        }

        case 'list_channels': {
          const result = await pool.query(
            `SELECT c.id, c.name, c.description, c.instructions, c.delivery_mode
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
            `SELECT m.id, m.content, m.message_type, m.session_id, m.created_at, u.name as user_name,
                    s.label as session_label
             FROM messages m
             JOIN users u ON u.id = m.user_id
             LEFT JOIN sessions s ON s.session_token = m.session_id
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

        case 'register_session': {
          const { channel_id, session_token } = args;
          if (!channel_id || !session_token) {
            return res.json({ error: 'channel_id and session_token are required' });
          }

          // Verify channel membership (admins auto-join)
          const regMemberCheck = await pool.query(
            'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
            [channel_id, user.id]
          );
          if (regMemberCheck.rows.length === 0) {
            if (user.role === 'admin') {
              await pool.query(
                'INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                [channel_id, user.id, 'admin']
              );
            } else {
              return res.status(403).json({ error: 'Not a member of this channel' });
            }
          }

          // Use custom label if provided, otherwise assign sequential number
          let label = args.label;
          let sessionNumber = null;
          if (!label) {
            const activeResult = await pool.query(
              'SELECT COUNT(*) FROM sessions WHERE user_id = $1 AND channel_id = $2 AND is_connected = true',
              [user.id, channel_id]
            );
            sessionNumber = parseInt(activeResult.rows[0].count) + 1;
            label = `Session ${sessionNumber}`;
          }

          // Upsert the session record
          await pool.query(
            `INSERT INTO sessions (session_token, user_id, channel_id, label, is_connected, connected_at)
             VALUES ($1, $2, $3, $4, true, NOW())
             ON CONFLICT (session_token) DO UPDATE SET is_connected = true, connected_at = NOW(), label = $4`,
            [session_token, user.id, channel_id, label]
          );

          // Broadcast so browsers refresh the active-session list and reflect the label
          broadcastToChannel(String(channel_id), {
            type: 'session_renamed',
            session_token,
            label,
          });

          // Return channel name + shared instructions + delivery mode so the session learns its context
          const channelInfo = await pool.query(
            'SELECT name, instructions, delivery_mode FROM channels WHERE id = $1',
            [channel_id]
          );

          return res.json({
            label,
            session_number: sessionNumber,
            session_token,
            channel_name: channelInfo.rows[0]?.name || null,
            instructions: channelInfo.rows[0]?.instructions || null,
            delivery_mode: channelInfo.rows[0]?.delivery_mode || 'broadcast',
          });
        }

        case 'rename_session': {
          const { session_token, label } = args;
          if (!session_token || !label || typeof label !== 'string' || !label.trim()) {
            return res.json({ error: 'session_token and label are required' });
          }
          if (label.length > 100) return res.json({ error: 'Label too long (max 100 characters)' });

          // Verify the session belongs to this user
          const sessRes = await pool.query(
            'SELECT id, channel_id, user_id FROM sessions WHERE session_token = $1',
            [session_token]
          );
          if (sessRes.rows.length === 0) return res.json({ error: 'Session not found' });
          if (sessRes.rows[0].user_id !== user.id) {
            return res.status(403).json({ error: 'You can only rename your own session' });
          }

          const newLabel = label.trim();
          await pool.query('UPDATE sessions SET label = $1 WHERE session_token = $2', [newLabel, session_token]);

          broadcastToChannel(String(sessRes.rows[0].channel_id), {
            type: 'session_renamed',
            session_token,
            session_id: sessRes.rows[0].id,
            label: newLabel,
          });

          return res.json({ success: true, label: newLabel });
        }

        case 'set_channel_instructions': {
          const { channel_id, instructions } = args;
          if (!channel_id) return res.json({ error: 'channel_id is required' });
          if (instructions !== null && instructions !== undefined && typeof instructions !== 'string') {
            return res.json({ error: 'instructions must be a string or null' });
          }
          if (typeof instructions === 'string' && instructions.length > 10000) {
            return res.json({ error: 'Instructions too long (max 10000 characters)' });
          }

          // Verify membership (any member can edit)
          const instrMemberCheck = await pool.query(
            'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
            [channel_id, user.id]
          );
          if (instrMemberCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Not a member of this channel' });
          }

          const result = await pool.query(
            'UPDATE channels SET instructions = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, instructions',
            [instructions || null, channel_id]
          );
          if (result.rows.length === 0) return res.json({ error: 'Channel not found' });

          broadcastToChannel(String(channel_id), {
            type: 'channel_instructions_updated',
            channel_id: Number(channel_id),
            instructions: result.rows[0].instructions,
            updated_by: user.name,
          });

          return res.json({ success: true, instructions: result.rows[0].instructions });
        }

        case 'set_channel_mode': {
          const { channel_id, mode } = args;
          if (!channel_id) return res.json({ error: 'channel_id is required' });
          if (mode !== 'broadcast' && mode !== 'mention') {
            return res.json({ error: "mode must be 'broadcast' or 'mention'" });
          }

          // Verify membership (any member can change the mode)
          const modeMemberCheck = await pool.query(
            'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
            [channel_id, user.id]
          );
          if (modeMemberCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Not a member of this channel' });
          }

          const result = await pool.query(
            'UPDATE channels SET delivery_mode = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, delivery_mode',
            [mode, channel_id]
          );
          if (result.rows.length === 0) return res.json({ error: 'Channel not found' });

          broadcastToChannel(String(channel_id), {
            type: 'channel_mode_updated',
            channel_id: Number(channel_id),
            delivery_mode: result.rows[0].delivery_mode,
            updated_by: user.name,
          });

          return res.json({ success: true, delivery_mode: result.rows[0].delivery_mode });
        }

        case 'create_channel': {
          const { name, description, member_ids } = args;
          if (!name || typeof name !== 'string' || !name.trim()) {
            return res.json({ error: 'name is required' });
          }

          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            const channelResult = await client.query(
              'INSERT INTO channels (name, description, created_by) VALUES ($1, $2, $3) RETURNING *',
              [name.trim(), description || null, user.id]
            );
            const channel = channelResult.rows[0];

            // Add creator as admin member
            await client.query(
              'INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3)',
              [channel.id, user.id, 'admin']
            );

            // Add additional members
            if (member_ids && Array.isArray(member_ids)) {
              for (const memberId of member_ids) {
                if (memberId !== user.id) {
                  await client.query(
                    'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [channel.id, memberId]
                  );
                }
              }
            }

            await client.query('COMMIT');
            return res.json({ success: true, channel: { id: channel.id, name: channel.name, description: channel.description } });
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }
        }

        case 'add_channel_member': {
          const { channel_id, user_id: targetUserId, email } = args;
          if (!channel_id) return res.json({ error: 'channel_id is required' });
          if (!targetUserId && !email) return res.json({ error: 'user_id or email is required' });

          // Verify caller is admin of the channel
          const adminCheck = await pool.query(
            "SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2 AND role = 'admin'",
            [channel_id, user.id]
          );
          if (adminCheck.rows.length === 0) {
            return res.status(403).json({ error: 'You must be a channel admin to add members' });
          }

          // Resolve user by email if needed
          let resolvedUserId = targetUserId;
          if (!resolvedUserId && email) {
            const userResult = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);
            if (userResult.rows.length === 0) {
              return res.json({ error: `No user found with email: ${email}` });
            }
            resolvedUserId = userResult.rows[0].id;
          }

          await pool.query(
            'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [channel_id, resolvedUserId]
          );

          const addedUser = await pool.query('SELECT name, email FROM users WHERE id = $1', [resolvedUserId]);
          const userName = addedUser.rows[0]?.name || 'Unknown';
          return res.json({ success: true, message: `${userName} added to channel` });
        }

        case 'modify_channel': {
          const { channel_id, name, description } = args;
          if (!channel_id) return res.json({ error: 'channel_id is required' });
          if (!name && description === undefined) return res.json({ error: 'Provide name and/or description to update' });

          // Verify caller is admin of the channel
          const modAdminCheck = await pool.query(
            "SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2 AND role = 'admin'",
            [channel_id, user.id]
          );
          if (modAdminCheck.rows.length === 0) {
            return res.status(403).json({ error: 'You must be a channel admin to modify it' });
          }

          const updates = [];
          const values = [];
          let paramIndex = 1;

          if (name) {
            updates.push(`name = $${paramIndex++}`);
            values.push(name.trim());
          }
          if (description !== undefined) {
            updates.push(`description = $${paramIndex++}`);
            values.push(description || null);
          }
          updates.push(`updated_at = NOW()`);
          values.push(channel_id);

          const result = await pool.query(
            `UPDATE channels SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, name, description`,
            values
          );
          if (result.rows.length === 0) return res.json({ error: 'Channel not found' });
          return res.json({ success: true, channel: result.rows[0] });
        }

        default:
          return res.json({ error: `Unknown tool: ${tool}` });
      }
    } catch (err) {
      console.error('[mcp]', err); res.status(500).json({ error: 'Internal server error' });
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
        {
          name: 'create_channel',
          description: 'Create a new channel. You become the admin. Optionally add members by user ID.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Channel name' },
              description: { type: 'string', description: 'Channel description' },
              member_ids: { type: 'array', items: { type: 'number' }, description: 'User IDs to add as members' },
            },
            required: ['name'],
          },
        },
        {
          name: 'add_channel_member',
          description: 'Add a user to a channel (requires channel admin). Specify user by ID or email.',
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: { type: 'number', description: 'Channel ID' },
              user_id: { type: 'number', description: 'User ID to add' },
              email: { type: 'string', description: 'Email of user to add (alternative to user_id)' },
            },
            required: ['channel_id'],
          },
        },
        {
          name: 'modify_channel',
          description: 'Update a channel name and/or description (requires channel admin).',
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: { type: 'number', description: 'Channel ID' },
              name: { type: 'string', description: 'New channel name' },
              description: { type: 'string', description: 'New channel description' },
            },
            required: ['channel_id'],
          },
        },
        {
          name: 'set_channel_mode',
          description: "Set a channel's delivery mode (any member). 'broadcast' pushes every message to every connected session; 'mention' pushes only to @<session-label>-mentioned sessions (others can still read history).",
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: { type: 'number', description: 'Channel ID' },
              mode: { type: 'string', enum: ['broadcast', 'mention'], description: "Delivery mode" },
            },
            required: ['channel_id', 'mode'],
          },
        },
      ],
    });
  });
}

/**
 * Push a message to SSE-connected Claude Code sessions in a channel
 * (excluding the sender's session). When allowedTokens is a Set, only sessions
 * whose token is in it receive the push (used for mention-only delivery mode);
 * pass null to push to every session in the channel.
 */
function pushToChannel(channelId, excludeSessionToken, data, allowedTokens = null) {
  for (const [token, client] of sseClients) {
    if (String(client.channelId) !== String(channelId)) continue;
    if (token === excludeSessionToken) continue;
    if (allowedTokens && !allowedTokens.has(token)) continue;
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

module.exports = { setupMcpRoutes };
