#!/usr/bin/env node

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Config file stores auth state between sessions
const CONFIG_DIR = path.join(require('os').homedir(), '.mcp-chat');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const MCP_CHAT_URL = process.env.MCP_CHAT_URL || 'https://mcpchat.dovito.com';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Config persistence ──────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiCall(tool, args, token) {
  const response = await fetch(`${MCP_CHAT_URL}/mcp/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ tool, args }),
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ─── Channel notification (push messages into Claude's context) ──────────────

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(`${msg}\n`);
}

function pushChannelMessage(source, content, meta) {
  sendNotification('notifications/claude/channel', {
    content,
    meta: { source, ...meta },
  });
}

// ─── WebSocket listener for real-time channel messages ───────────────────────

let wsConnection = null;
let wsReconnectTimeout = null;

function connectWebSocket() {
  if (!sessionState.connected || !sessionState.token || !sessionState.channelId) return;

  const wsUrl = `${MCP_CHAT_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/ws?token=${sessionState.token}&channel=${sessionState.channelId}&session=mcp-cli`;

  if (wsConnection) {
    try { wsConnection.close(); } catch {}
  }

  const ws = new WebSocket(wsUrl);
  wsConnection = ws;

  ws.on('open', () => {
    process.stderr.write(`[mcp-chat] WebSocket connected to #${sessionState.channelName}\n`);
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === 'new_message') {
        const msg = data.message;
        // Don't echo back messages sent by this user's session
        if (msg.user_id === sessionState.userId) return;

        pushChannelMessage('mcp-chat', msg.content, {
          channel: sessionState.channelName,
          user: msg.user_name || 'unknown',
          message_type: msg.message_type || 'info',
          timestamp: msg.created_at || new Date().toISOString(),
        });
      } else if (data.type === 'presence') {
        // Only push presence for Claude Code sessions (have session_token), not browser refreshes
        if (!data.session_token) return;
        // Don't push own presence events
        if (data.user_id === sessionState.userId) return;

        pushChannelMessage('mcp-chat', `${data.user_name} ${data.status} #${sessionState.channelName}`, {
          channel: sessionState.channelName,
          event: 'presence',
          user: data.user_name,
          status: data.status,
        });
      }
    } catch (err) {
      process.stderr.write(`[mcp-chat] WebSocket parse error: ${err.message}\n`);
    }
  });

  ws.on('close', () => {
    process.stderr.write(`[mcp-chat] WebSocket disconnected, reconnecting in 5s...\n`);
    wsReconnectTimeout = setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (err) => {
    process.stderr.write(`[mcp-chat] WebSocket error: ${err.message}\n`);
  });
}

function disconnectWebSocket() {
  if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
  if (wsConnection) {
    try { wsConnection.close(); } catch {}
    wsConnection = null;
  }
}

// ─── Browser auth flow ───────────────────────────────────────────────────────

function startAuthFlow() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/callback') {
        const token = url.searchParams.get('token');
        const channelId = url.searchParams.get('channel_id');
        const channelName = url.searchParams.get('channel_name');
        const userName = url.searchParams.get('user_name');

        const parsedChannelId = parseInt(channelId, 10);
        if (!token || !channelId || isNaN(parsedChannelId) || parsedChannelId <= 0) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid callback parameters');
          return;
        }

        const safeChannelName = escapeHtml(channelName || channelId);
        const safeRedirectUrl = escapeHtml(`${MCP_CHAT_URL}/chat/${parsedChannelId}`);

        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        });
        res.end(`<!DOCTYPE html>
<html><head><title>MCP Chat - Connected</title>
<meta http-equiv="refresh" content="2;url=${safeRedirectUrl}">
</head>
<body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f8fafc;">
<div style="text-align: center; max-width: 400px;">
<h1 style="color: #0f172a;">Connected!</h1>
<p style="color: #64748b;">Your Claude Code session is now connected to <strong>#${safeChannelName}</strong>.</p>
<p style="color: #64748b; font-size: 14px;">You can close this tab and return to your terminal.</p>
</div></body></html>`);

        server.close();
        resolve({ token, channelId: parsedChannelId, channelName: channelName || '', userName: userName || '' });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const connectUrl = `${MCP_CHAT_URL}/connect?callback=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}`;

      try {
        const open = (await import('open')).default;
        await open(connectUrl);
      } catch {
        const { spawn } = require('child_process');
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        spawn(cmd, [connectUrl], { stdio: 'ignore', detached: true }).unref();
      }
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Auth flow timed out after 5 minutes'));
    }, 300000);
  });
}

// ─── MCP Protocol (JSON-RPC over stdio) ──────────────────────────────────────

let sessionState = {
  token: null,
  channelId: null,
  channelName: null,
  userName: null,
  userId: null,
  connected: false,
};

// Load saved config on startup
const savedConfig = loadConfig();
if (savedConfig.token) {
  sessionState.token = savedConfig.token;
  sessionState.userName = savedConfig.userName;
  sessionState.userId = savedConfig.userId;
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`${msg}\n`);
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`${msg}\n`);
}

function getTools() {
  return [
    {
      name: 'mcp_chat_connect',
      description: sessionState.connected
        ? `Currently connected to #${sessionState.channelName} as ${sessionState.userName}. Live messages are being pushed into this session. Run again to switch channels.`
        : 'Connect to MCP Chat. Opens your browser to authenticate and select a channel. Once connected, messages will be pushed into this session in real-time.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'mcp_chat_send',
      description: 'Send a message to your connected MCP Chat channel. Messages are informational or recommendations, never direct orders.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Message content' },
          message_type: { type: 'string', enum: ['info', 'recommendation', 'status'], description: 'Type of message (default: info)' },
        },
        required: ['content'],
      },
    },
    {
      name: 'mcp_chat_read',
      description: 'Read recent messages from your connected MCP Chat channel.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of messages to fetch (default: 20, max: 100)' },
        },
      },
    },
    {
      name: 'mcp_chat_presence',
      description: 'See who is online and which Claude Code sessions are active in your channel.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'mcp_chat_channels',
      description: 'List all MCP Chat channels you are a member of.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'mcp_chat_status',
      description: 'Check your current MCP Chat connection status.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'mcp_chat_connect': {
      try {
        // Disconnect existing WebSocket if switching channels
        disconnectWebSocket();

        const result = await startAuthFlow();

        // Decode the JWT to get userId (base64 payload)
        let userId = null;
        try {
          const payload = JSON.parse(Buffer.from(result.token.split('.')[1], 'base64').toString());
          userId = payload.id;
        } catch {}

        sessionState = {
          token: result.token,
          channelId: result.channelId,
          channelName: result.channelName,
          userName: result.userName,
          userId,
          connected: true,
        };
        saveConfig({ token: result.token, userName: result.userName, userId });

        // Start WebSocket listener for real-time push
        connectWebSocket();

        return { content: [{ type: 'text', text: `Connected to #${result.channelName} as ${result.userName}. Live messages will now be pushed into this session. You can also use mcp_chat_send to send messages and mcp_chat_read to fetch history.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Connection failed: ${err.message}` }], isError: true };
      }
    }

    case 'mcp_chat_send': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_connect first.' }], isError: true };
      }
      const content = String(args.content || '').slice(0, 10000);
      if (!content) return { content: [{ type: 'text', text: 'Message content is required.' }], isError: true };
      const messageType = ['info', 'recommendation', 'status'].includes(args.message_type) ? args.message_type : 'info';
      const result = await apiCall('send_message', {
        channel_id: sessionState.channelId,
        content,
        message_type: messageType,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Message sent to #${sessionState.channelName}` }] };
    }

    case 'mcp_chat_read': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_connect first.' }], isError: true };
      }
      const limit = Math.max(1, Math.min(100, parseInt(args.limit, 10) || 20));
      const result = await apiCall('get_messages', {
        channel_id: sessionState.channelId,
        limit,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      if (!result.messages || result.messages.length === 0) {
        return { content: [{ type: 'text', text: `No messages in #${sessionState.channelName}` }] };
      }
      const formatted = result.messages.map(m =>
        `[${new Date(m.created_at).toLocaleTimeString()}] ${m.user_name}: ${m.content}`
      ).join('\n');
      return { content: [{ type: 'text', text: `Messages in #${sessionState.channelName}:\n${formatted}` }] };
    }

    case 'mcp_chat_presence': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_connect first.' }], isError: true };
      }
      const result = await apiCall('get_presence', { channel_id: sessionState.channelId }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      if (!result.sessions || result.sessions.length === 0) {
        return { content: [{ type: 'text', text: `No active sessions in #${sessionState.channelName}` }] };
      }
      const formatted = result.sessions.map(s =>
        `- ${s.user_name} (${s.label || 'Claude session'}) ${s.is_connected ? 'online' : 'offline'}`
      ).join('\n');
      return { content: [{ type: 'text', text: `Active in #${sessionState.channelName}:\n${formatted}` }] };
    }

    case 'mcp_chat_channels': {
      if (!sessionState.token) {
        return { content: [{ type: 'text', text: 'Not authenticated. Run mcp_chat_connect first.' }], isError: true };
      }
      const result = await apiCall('list_channels', {}, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      if (!result.channels || result.channels.length === 0) {
        return { content: [{ type: 'text', text: 'No channels available.' }] };
      }
      const formatted = result.channels.map(c => `- #${c.name} (ID: ${c.id})${c.description ? ` -- ${c.description}` : ''}`).join('\n');
      return { content: [{ type: 'text', text: `Your channels:\n${formatted}` }] };
    }

    case 'mcp_chat_status': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: sessionState.token ? 'Authenticated but not connected to a channel. Run mcp_chat_connect to pick a channel.' : 'Not connected. Run mcp_chat_connect to authenticate and select a channel.' }] };
      }
      const wsStatus = wsConnection?.readyState === 1 ? 'live (receiving messages)' : 'reconnecting...';
      return { content: [{ type: 'text', text: `Connected to #${sessionState.channelName} as ${sessionState.userName}\nWebSocket: ${wsStatus}` }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ─── JSON-RPC message handler ────────────────────────────────────────────────

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          experimental: { 'claude/channel': {} },
        },
        serverInfo: { name: 'mcp-chat-connect', version: '1.1.0' },
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      sendResponse(id, { tools: getTools() });
      break;

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await handleToolCall(name, args || {});
        sendResponse(id, result);
      } catch (err) {
        sendResponse(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
      break;
    }

    default:
      if (id) sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── stdio transport ─────────────────────────────────────────────────────────

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (line.trim()) {
      try {
        handleMessage(JSON.parse(line));
      } catch (err) {
        process.stderr.write(`Parse error: ${err.message}\n`);
      }
    }
  }
});

process.stdin.on('end', () => {
  disconnectWebSocket();
  process.exit(0);
});

// Clean shutdown
process.on('SIGTERM', () => { disconnectWebSocket(); process.exit(0); });
process.on('SIGINT', () => { disconnectWebSocket(); process.exit(0); });
