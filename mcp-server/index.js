#!/usr/bin/env node

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// Config file stores auth state between sessions
const CONFIG_DIR = path.join(require('os').homedir(), '.mcp-chat');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
// Marker file the status-line wrapper reads to decide whether to report this
// session's remaining-context %. Present+fresh only while actually connected.
// Keyed by the PROJECT DIRECTORY (not the Claude session id): the connector's
// CLAUDE_CODE_SESSION_ID is ephemeral and does NOT match the id the status line
// reports for resumed sessions, so session-id keying silently failed. The
// project dir is stable and identical on both sides -- the connector has
// CLAUDE_PROJECT_DIR and the status-line stdin has workspace.project_dir. The
// marker also stamps project_dir so the wrapper can match it exactly.
const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const PROJECT_KEY = crypto.createHash('sha1').update(PROJECT_DIR).digest('hex').slice(0, 16);
const CC_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID || null; // informational only now
const MARKER_FILE = path.join(CONFIG_DIR, `active-session-${PROJECT_KEY}.json`);

const MCP_CHAT_URL = process.env.MCP_CHAT_URL;
if (!MCP_CHAT_URL) {
  process.stderr.write('FATAL: MCP_CHAT_URL environment variable is required.\n');
  process.stderr.write('Set it when adding the MCP server, e.g.:\n');
  process.stderr.write('  claude mcp add -e MCP_CHAT_URL=https://your-domain.com -s user mcp-chat -- npx -y mcp-chat-connect@latest\n');
  process.exit(1);
}

const LOCAL_VERSION = require('./package.json').version;

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

// ─── Active-session marker (for the status-line context reporter) ─────────────
// Written on every successful connect/join, removed on disconnect/shutdown. The
// self-gating status-line wrapper only POSTs context while this file exists and
// is fresh (<15 min old). Teardown is therefore crash-safe: if the process dies
// without clearing the marker, it simply goes stale and reporting stops.
//
// Markers are keyed by the PROJECT DIRECTORY: each is
// active-session-<sha1(project_dir).slice(0,16)>.json and stamped with the
// project_dir it belongs to, so the wrapper can match it against the status-line
// stdin workspace.project_dir. Residual limitation: two concurrent channel
// sessions in the SAME project dir share one marker (last writer wins) -- a
// narrow, acceptable case.
const MARKER_MAX_AGE_MS = 15 * 60 * 1000; // 15 min -- matches the wrapper's freshness gate
const MARKER_FILE_RE = /^active-session(-.*)?\.json$/;

function writeSessionMarker() {
  try {
    if (!sessionState.connected || !sessionState.sessionToken || !sessionState.token) return;
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const marker = {
      session_token: sessionState.sessionToken,
      token: sessionState.token,
      api_base_url: MCP_CHAT_URL,
      project_dir: PROJECT_DIR,
      cc_session_id: CC_SESSION_ID,
      channel_id: sessionState.channelId,
      channel_name: sessionState.channelName,
      session_label: sessionState.sessionLabel || null,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(MARKER_FILE, JSON.stringify(marker, null, 2), { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[mcp-chat] Could not write session marker: ${err.message}\n`);
  }
}

function clearSessionMarker() {
  try {
    fs.rmSync(MARKER_FILE, { force: true });
  } catch {
    // ignore -- best-effort cleanup (ENOENT etc.)
  }
}

// Best-effort cleanup of markers left behind by crashed sessions: any
// active-session*.json whose updated_at is stale (>15 min) or unparseable is
// removed. Runs once on connect. NEVER throws -- purely opportunistic.
function sweepStaleMarkers() {
  try {
    const entries = fs.readdirSync(CONFIG_DIR);
    for (const name of entries) {
      if (!MARKER_FILE_RE.test(name)) continue;
      const full = path.join(CONFIG_DIR, name);
      let stale = true;
      try {
        const marker = JSON.parse(fs.readFileSync(full, 'utf8'));
        const ts = Date.parse(marker && marker.updated_at);
        stale = !Number.isFinite(ts) || Date.now() - ts > MARKER_MAX_AGE_MS;
      } catch {
        stale = true; // unparseable -> treat as stale
      }
      if (stale) {
        try { fs.rmSync(full, { force: true }); } catch {}
      }
    }
  } catch {
    // ignore -- CONFIG_DIR may not exist yet, or be unreadable; never throw
  }
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

// ─── Version check ──────────────────────────────────────────────────────────

function isNewerVersion(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdate() {
  try {
    const response = await fetch(`${MCP_CHAT_URL}/api/version`);
    if (!response.ok) return null;
    const { latest } = await response.json();
    if (latest && isNewerVersion(latest, LOCAL_VERSION)) {
      return `UPDATE AVAILABLE: You are running mcp-chat-connect v${LOCAL_VERSION}, but v${latest} is available. Run: npm install -g mcp-chat-connect`;
    }
  } catch {}
  return null;
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

// Heads-up appended to connect/join text when a channel is mentions-only, so the
// session understands silence does not mean nobody is talking. Empty for broadcast.
function deliveryModeNotice(label) {
  const name = label || 'your session name';
  return `\n\nThis channel is in mentions-only mode: you will only be pushed messages that @mention your session name ("${name}"). Other messages won't interrupt you -- use mcp_chat_read to catch up on the full channel.`;
}

// ─── WebSocket listener for real-time channel messages ───────────────────────

let wsConnection = null;
let wsReconnectTimeout = null;

function connectWebSocket() {
  if (!sessionState.connected || !sessionState.token || !sessionState.channelId) return;

  // Note: JWT is passed as a query parameter because WebSocket does not support custom headers.
  // Be aware this token may appear in server/proxy access logs.
  const wsUrl = `${MCP_CHAT_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/ws?token=${sessionState.token}&channel=${sessionState.channelId}&session=${sessionState.sessionToken}`;

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
        // Don't echo back messages sent by this Claude session itself
        // But DO receive messages from the same user's browser UI
        if (msg.session_id === sessionState.sessionToken) return;

        const senderLabel = msg.session_id
          ? `${msg.user_name?.split(' ')[0]}'s Claude${msg.session_label ? ` (${msg.session_label})` : ''}`
          : msg.user_name || 'unknown';

        // In mentions-only channels, the server only delivers messages that @mention
        // this session and tags them mentioned:true -- flag it as a direct ping.
        const content = data.mentioned
          ? `[You were @mentioned] ${msg.content}`
          : msg.content;

        // NOTE: channel notification `meta` is Record<string,string> -- every value
        // MUST be a string, or Claude Code silently drops the whole notification.
        // Only attach `mentioned` (as a string) on actual mentions.
        pushChannelMessage('mcp-chat', content, {
          channel: sessionState.channelName,
          user: senderLabel,
          message_type: msg.message_type || 'info',
          ...(data.mentioned ? { mentioned: 'true' } : {}),
          timestamp: msg.created_at || new Date().toISOString(),
        });
      } else if (data.type === 'session_renamed') {
        // Only react when this session itself was renamed (e.g. from the browser)
        if (data.session_token !== sessionState.sessionToken) return;
        if (data.label === sessionState.sessionLabel) return;
        sessionState.sessionLabel = data.label;
        pushChannelMessage('mcp-chat', `This session has been named "${data.label}". Refer to yourself as "${data.label}" in #${sessionState.channelName}.`, {
          channel: sessionState.channelName,
          event: 'session_renamed',
          session_label: data.label,
        });
      } else if (data.type === 'channel_instructions_updated') {
        // Skip the echo of a change this session just made itself
        if ((data.instructions || null) === sessionState.sessionInstructions) return;
        sessionState.sessionInstructions = data.instructions || null;
        const body = data.instructions
          ? `Channel instructions for #${sessionState.channelName} were updated${data.updated_by ? ` by ${data.updated_by}` : ''}. Follow these instructions for this channel:\n\n${data.instructions}`
          : `Channel instructions for #${sessionState.channelName} were cleared.`;
        pushChannelMessage('mcp-chat', body, {
          channel: sessionState.channelName,
          event: 'channel_instructions_updated',
        });
      } else if (data.type === 'channel_mode_updated') {
        const mode = data.delivery_mode === 'mention' ? 'mention' : 'broadcast';
        if (mode === sessionState.deliveryMode) return; // skip echo of our own change
        sessionState.deliveryMode = mode;
        const body = mode === 'mention'
          ? `Delivery for #${sessionState.channelName} was set to mentions-only${data.updated_by ? ` by ${data.updated_by}` : ''}. From now on you will only be pushed messages that @mention your session name ("${sessionState.sessionLabel || 'your session'}"). Use mcp_chat_read to catch up on anything else.`
          : `Delivery for #${sessionState.channelName} was set to broadcast${data.updated_by ? ` by ${data.updated_by}` : ''}. You will now be pushed every message in the channel.`;
        pushChannelMessage('mcp-chat', body, {
          channel: sessionState.channelName,
          event: 'channel_mode_updated',
          delivery_mode: mode,
        });
      } else if (data.type === 'channel_updated') {
        if (data.name && data.name !== sessionState.channelName) sessionState.channelName = data.name;
        pushChannelMessage('mcp-chat', `Channel renamed/updated to #${data.name}${data.description ? ` -- ${data.description}` : ''}${data.updated_by ? ` by ${data.updated_by}` : ''}.`, {
          channel: sessionState.channelName,
          event: 'channel_updated',
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
  // Remove the active-session marker so the status-line wrapper stops reporting.
  // On a channel switch a fresh marker is re-written right after re-registering.
  clearSessionMarker();
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
  sessionToken: null,
  sessionLabel: null,
  sessionInstructions: null,
  deliveryMode: 'broadcast',
  connected: false,
};

// Load saved config on startup
const savedConfig = loadConfig();
if (savedConfig.token) {
  sessionState.token = savedConfig.token;
  sessionState.userName = savedConfig.userName;
  sessionState.userId = savedConfig.userId;
}

// Auto-connect from env vars (headless/bot mode)
const envToken = process.env.MCP_CHAT_TOKEN;
const envChannel = process.env.MCP_CHAT_CHANNEL;
if (envToken && envChannel) {
  let userId = null;
  let userName = process.env.MCP_CHAT_USER_NAME || 'Bot';
  try {
    const payload = JSON.parse(Buffer.from(envToken.split('.')[1], 'base64').toString());
    userId = payload.id;
    userName = process.env.MCP_CHAT_USER_NAME || payload.name || 'Bot';
  } catch {}

  const sessionToken = `mcp-${crypto.randomBytes(16).toString('hex')}`;
  sessionState = {
    token: envToken,
    channelId: parseInt(envChannel, 10),
    channelName: process.env.MCP_CHAT_CHANNEL_NAME || `channel-${envChannel}`,
    userName,
    userId,
    sessionToken,
    sessionLabel: null,
    sessionInstructions: null,
    deliveryMode: 'broadcast',
    connected: true,
  };

  // Register session for label + channel instructions, then connect WebSocket
  apiCall('register_session', {
    channel_id: sessionState.channelId,
    session_token: sessionToken,
    label: process.env.MCP_CHAT_SESSION_NAME || undefined,
  }, envToken).then(result => {
    sessionState.sessionLabel = result.label || 'Session';
    sessionState.sessionInstructions = result.instructions || null;
    sessionState.deliveryMode = result.delivery_mode || 'broadcast';
    if (result.channel_name) sessionState.channelName = result.channel_name;
    process.stderr.write(`[mcp-chat] Auto-connected to #${sessionState.channelName} as ${userName} (${sessionState.sessionLabel})\n`);
  }).catch(() => {
    process.stderr.write(`[mcp-chat] Auto-connected to #${sessionState.channelName} as ${userName}\n`);
  }).finally(() => {
    connectWebSocket();
    sweepStaleMarkers();
    writeSessionMarker();
  });
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
        ? `Currently connected to #${sessionState.channelName} as ${sessionState.userName} (${sessionState.sessionLabel || 'Session'}). Live messages are being pushed into this session. Run again to switch channels.`
        : 'Connect to MCP Chat. Opens your browser to authenticate and select a channel. Once connected, messages will be pushed into this session in real-time. Optionally pass a label to name this session.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional name for this session (e.g. "Backend Dev", "QA"). Defaults to a sequential "Session N".' },
        },
        required: [],
      },
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
    {
      name: 'mcp_chat_join',
      description: 'Connect to a specific MCP Chat channel by ID without opening a browser. Requires prior authentication (saved token from a previous mcp_chat_connect). Used by agents to join channels created by the parent session.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'number', description: 'Channel ID to join' },
          label: { type: 'string', description: 'Custom session label (e.g. "QA Agent", "Security Checker"). Defaults to sequential "Session N".' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'mcp_chat_create_channel',
      description: 'Create a new MCP Chat channel. You become the admin.',
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
      name: 'mcp_chat_add_member',
      description: 'Add a user to a channel (requires channel admin). Specify user by ID or email.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'number', description: 'Channel ID (defaults to connected channel)' },
          user_id: { type: 'number', description: 'User ID to add' },
          email: { type: 'string', description: 'Email of user to add (alternative to user_id)' },
        },
      },
    },
    {
      name: 'mcp_chat_modify_channel',
      description: 'Update a channel name and/or description (requires channel admin).',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'number', description: 'Channel ID (defaults to connected channel)' },
          name: { type: 'string', description: 'New channel name' },
          description: { type: 'string', description: 'New channel description' },
        },
      },
    },
    {
      name: 'mcp_chat_set_name',
      description: 'Set or change the name of your own session. Other participants (and you) will see this name on every message you send.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name for this session (e.g. "Backend Dev", "QA Agent").' },
        },
        required: ['name'],
      },
    },
    {
      name: 'mcp_chat_instructions',
      description: 'Show the current channel instructions (a shared system prompt set for everyone in the channel).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'mcp_chat_set_instructions',
      description: 'Set the channel instructions: a shared system prompt that every connected session in the channel sees. Pass an empty string to clear. Any channel member can set these.',
      inputSchema: {
        type: 'object',
        properties: {
          instructions: { type: 'string', description: 'The shared instructions for the channel. Empty string clears them.' },
        },
        required: ['instructions'],
      },
    },
    {
      name: 'mcp_chat_set_mode',
      description: "Set the channel's delivery mode (any member). 'broadcast' pushes every message to every connected session; 'mention' pushes only to sessions that are @<session-name>-mentioned (others can still mcp_chat_read). Browsers always see every message either way.",
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['broadcast', 'mention'], description: "'broadcast' or 'mention'" },
        },
        required: ['mode'],
      },
    },
  ];
}

// ─── MCP resource: status-line wrapper + one-time install guide ──────────────

const STATUS_LINE_RESOURCE_URI = 'mcp-chat://status-line-wrapper';

function readWrapperSource() {
  try {
    return fs.readFileSync(path.join(__dirname, 'status-line-wrapper.js'), 'utf8');
  } catch {
    return null;
  }
}

function buildStatusLineResourceText() {
  const wrapperSrc = readWrapperSource();
  const wrapperPath = path.join(CONFIG_DIR, 'status-line-wrapper.js');
  const backupPath = path.join(CONFIG_DIR, 'status-line-config.json');
  const settingsPath = path.join(require('os').homedir(), '.claude', 'settings.json');

  const scriptBlock = wrapperSrc
    ? '```js\n' + wrapperSrc + '\n```'
    : '_(Wrapper source could not be read from the installed package. It also ships as `status-line-wrapper.js` inside the `mcp-chat-connect` package directory -- copy it from there.)_';

  return `# MCP Chat -- context status-line wrapper (one-time install)

Installing this once lets **other** Claude Code sessions in your channel see your
live remaining-context % as a badge in the "Claude Sessions" list. It is a thin,
**self-gating** wrapper around your existing status line:

- It **always** runs your original status-line command and passes its output
  straight through -- your status line never changes appearance and is never
  delayed.
- It **only** reports context while an mcp-chat session is actually connected.
  This connector writes a marker file keyed by the **project directory**
  (\`${CONFIG_DIR}/active-session-<projectdir-hash>.json\`, stamped with its
  \`project_dir\`) on connect and removes it on disconnect; the wrapper resolves
  **its own** marker by matching the status-line stdin \`workspace.project_dir\`.
  The project dir is stable across resumed sessions, so this survives a session
  resume where the Claude session id would have changed. When you are not
  connected -- or after a crash leaves a stale marker -- it silently does nothing
  (stale markers are also swept on the next connect). **No SessionEnd hook is
  required**; teardown is crash-safe. Residual limitation: two concurrent channel
  sessions in the **same project dir** share one marker (last writer wins) -- a
  narrow, acceptable case.

The install is **idempotent** -- running these steps again when the wrapper is
already installed is a no-op.

## Install steps (perform ONCE)

1. **Check if already installed.** Read \`${settingsPath}\`. If its
   \`statusLine.command\` already contains \`status-line-wrapper.js\` (i.e. points
   at \`${wrapperPath}\`), the wrapper is already installed -- **STOP, nothing to
   do.**

2. **Write the wrapper script** below to \`${wrapperPath}\` with mode \`0755\`
   (create the \`${CONFIG_DIR}\` directory first if needed, mode \`0700\`).

3. **Back up the current status line.** Take the existing \`statusLine\` object
   from \`${settingsPath}\` (or \`null\` if there is none) and write:
   \`\`\`json
   { "upstream": <the existing statusLine object, or null> }
   \`\`\`
   to \`${backupPath}\`. The wrapper reads this to chain your original command.

4. **Point the status line at the wrapper.** Set \`statusLine\` in
   \`${settingsPath}\` to:
   \`\`\`json
   { "type": "command", "command": "node ${wrapperPath}" }
   \`\`\`
   (Preserve every other key in \`settings.json\` -- only replace \`statusLine\`.)

That's it. Your status line keeps working exactly as before; context reporting
turns itself on only while you are connected to mcp-chat.

## To uninstall
Restore \`statusLine\` in \`${settingsPath}\` from the \`upstream\` value saved in
\`${backupPath}\` (or remove \`statusLine\` entirely if that was \`null\`).

## Wrapper script (\`${wrapperPath}\`)

${scriptBlock}
`;
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

        const sessionToken = `mcp-${crypto.randomBytes(16).toString('hex')}`;
        sessionState = {
          token: result.token,
          channelId: result.channelId,
          channelName: result.channelName,
          userName: result.userName,
          userId,
          sessionToken,
          sessionLabel: null,
          sessionInstructions: null,
          deliveryMode: 'broadcast',
          connected: true,
        };
        saveConfig({ token: result.token, userName: result.userName, userId });

        // Register session to get label (custom or sequential) + channel instructions
        let sessionLabel = args.label || 'Session';
        try {
          const regResult = await apiCall('register_session', {
            channel_id: result.channelId,
            session_token: sessionToken,
            label: args.label || undefined,
          }, result.token);
          sessionLabel = regResult.label || sessionLabel;
          sessionState.sessionLabel = sessionLabel;
          sessionState.sessionInstructions = regResult.instructions || null;
          sessionState.deliveryMode = regResult.delivery_mode || 'broadcast';
        } catch {}

        // Start WebSocket listener for real-time push
        connectWebSocket();
        // Sweep any crashed-session markers, then write ours so the status-line
        // wrapper can report context for this session.
        sweepStaleMarkers();
        writeSessionMarker();

        // Check for package updates
        const updateNotice = await checkForUpdate();
        let responseText = `Connected to #${result.channelName} as ${result.userName} (${sessionLabel}). Your session is named "${sessionLabel}" -- this name appears on every message you send. Use mcp_chat_set_name to change it. Live messages will now be pushed into this session. You can also use mcp_chat_send to send messages and mcp_chat_read to fetch history.`;
        responseText += `\n\nTo share your live remaining-context % with other sessions (shown as a badge in the Claude Sessions list), install the status-line wrapper once -- it is idempotent and safe to re-run. Read resource mcp-chat://status-line-wrapper for the script and the one-time install steps.`;
        if (sessionState.deliveryMode === 'mention') {
          responseText += deliveryModeNotice(sessionLabel);
        }
        if (sessionState.sessionInstructions) {
          responseText += `\n\nChannel instructions for #${result.channelName} (apply these while in this channel):\n${sessionState.sessionInstructions}`;
        }
        if (updateNotice) {
          responseText += `\n\n${updateNotice}`;
        }

        return { content: [{ type: 'text', text: responseText }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Connection failed: ${err.message}` }], isError: true };
      }
    }

    case 'mcp_chat_join': {
      if (!sessionState.token) {
        return { content: [{ type: 'text', text: 'Not authenticated. A user must run mcp_chat_connect first to save credentials.' }], isError: true };
      }
      const channelId = parseInt(args.channel_id, 10);
      if (!channelId || isNaN(channelId)) {
        return { content: [{ type: 'text', text: 'Valid channel_id is required.' }], isError: true };
      }

      // Verify we can access this channel
      try {
        const channelsResult = await apiCall('list_channels', {}, sessionState.token);
        const channel = channelsResult.channels?.find(c => c.id === channelId);
        if (!channel) {
          return { content: [{ type: 'text', text: `Channel ${channelId} not found or you are not a member.` }], isError: true };
        }

        disconnectWebSocket();
        const sessionToken = `mcp-${crypto.randomBytes(16).toString('hex')}`;
        sessionState = {
          ...sessionState,
          channelId,
          channelName: channel.name,
          sessionToken,
          sessionLabel: null,
          sessionInstructions: null,
          deliveryMode: channel.delivery_mode || 'broadcast',
          connected: true,
        };

        // Register session to get label (custom or sequential) + channel instructions
        let sessionLabel = args.label || 'Session';
        try {
          const regResult = await apiCall('register_session', {
            channel_id: channelId,
            session_token: sessionToken,
            label: args.label || undefined,
          }, sessionState.token);
          sessionLabel = regResult.label || sessionLabel;
          sessionState.sessionLabel = sessionLabel;
          sessionState.sessionInstructions = regResult.instructions || null;
          sessionState.deliveryMode = regResult.delivery_mode || 'broadcast';
        } catch {}

        connectWebSocket();
        // Sweep any crashed-session markers, then write ours so the status-line
        // wrapper can report context for this session.
        sweepStaleMarkers();
        writeSessionMarker();
        let joinText = `Joined #${channel.name} (ID: ${channelId}) as ${sessionState.userName} (${sessionLabel}). Your session is named "${sessionLabel}"; use mcp_chat_set_name to change it. Live messages are now being pushed.`;
        joinText += `\n\nTo share your live remaining-context % with other sessions (shown as a badge in the Claude Sessions list), install the status-line wrapper once -- it is idempotent and safe to re-run. Read resource mcp-chat://status-line-wrapper for the script and the one-time install steps.`;
        if (sessionState.deliveryMode === 'mention') {
          joinText += deliveryModeNotice(sessionLabel);
        }
        if (sessionState.sessionInstructions) {
          joinText += `\n\nChannel instructions for #${channel.name} (apply these while in this channel):\n${sessionState.sessionInstructions}`;
        }
        return { content: [{ type: 'text', text: joinText }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to join channel: ${err.message}` }], isError: true };
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
        session_token: sessionState.sessionToken,
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
      const formatted = result.messages.map(m => {
        const sender = m.session_id
          ? `${m.user_name?.split(' ')[0]}'s Claude${m.session_label ? ` (${m.session_label})` : ''}`
          : m.user_name;
        return `[${new Date(m.created_at).toLocaleTimeString()}] ${sender}: ${m.content}`;
      }).join('\n');
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
        `- ${s.user_name} (${s.label || 'Claude session'}) ${s.is_connected ? 'online' : 'offline'}${s.context_remaining_pct != null ? ` -- context: ${s.context_remaining_pct}%` : ''}`
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
        return { content: [{ type: 'text', text: sessionState.token ? 'Authenticated but not connected to a channel. Run mcp_chat_connect or mcp_chat_join to pick a channel.' : 'Not connected. Run mcp_chat_connect to authenticate and select a channel.' }] };
      }
      const wsStatus = wsConnection?.readyState === 1 ? 'live (receiving messages)' : 'reconnecting...';
      const modeText = sessionState.deliveryMode === 'mention'
        ? `mentions-only (you are pushed only messages that @mention "${sessionState.sessionLabel || 'your session'}"; use mcp_chat_read for the rest)`
        : 'broadcast (you are pushed every message)';
      let statusText = `Connected to #${sessionState.channelName} as ${sessionState.userName} (${sessionState.sessionLabel || 'Session'})\nWebSocket: ${wsStatus}\nDelivery: ${modeText}`;
      if (sessionState.sessionInstructions) {
        statusText += `\n\nChannel instructions:\n${sessionState.sessionInstructions}`;
      }
      return { content: [{ type: 'text', text: statusText }] };
    }

    case 'mcp_chat_create_channel': {
      if (!sessionState.token) {
        return { content: [{ type: 'text', text: 'Not authenticated. Run mcp_chat_connect first.' }], isError: true };
      }
      const channelName = String(args.name || '').trim();
      if (!channelName) return { content: [{ type: 'text', text: 'Channel name is required.' }], isError: true };
      const result = await apiCall('create_channel', {
        name: channelName,
        description: args.description || null,
        member_ids: args.member_ids || [],
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Channel #${result.channel.name} created (ID: ${result.channel.id})${result.channel.description ? ` -- ${result.channel.description}` : ''}` }] };
    }

    case 'mcp_chat_add_member': {
      if (!sessionState.token) {
        return { content: [{ type: 'text', text: 'Not authenticated. Run mcp_chat_connect first.' }], isError: true };
      }
      const channelId = args.channel_id || sessionState.channelId;
      if (!channelId) return { content: [{ type: 'text', text: 'No channel specified and not connected to one.' }], isError: true };
      if (!args.user_id && !args.email) return { content: [{ type: 'text', text: 'Provide user_id or email.' }], isError: true };
      const result = await apiCall('add_channel_member', {
        channel_id: channelId,
        user_id: args.user_id || undefined,
        email: args.email || undefined,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text', text: result.message }] };
    }

    case 'mcp_chat_modify_channel': {
      if (!sessionState.token) {
        return { content: [{ type: 'text', text: 'Not authenticated. Run mcp_chat_connect first.' }], isError: true };
      }
      const channelId = args.channel_id || sessionState.channelId;
      if (!channelId) return { content: [{ type: 'text', text: 'No channel specified and not connected to one.' }], isError: true };
      const result = await apiCall('modify_channel', {
        channel_id: channelId,
        name: args.name || undefined,
        description: args.description !== undefined ? args.description : undefined,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Channel updated: #${result.channel.name}${result.channel.description ? ` -- ${result.channel.description}` : ''}` }] };
    }

    case 'mcp_chat_set_name': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_connect first.' }], isError: true };
      }
      const newName = String(args.name || '').trim().slice(0, 100);
      if (!newName) return { content: [{ type: 'text', text: 'A name is required.' }], isError: true };
      const result = await apiCall('rename_session', {
        session_token: sessionState.sessionToken,
        label: newName,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      sessionState.sessionLabel = result.label || newName;
      return { content: [{ type: 'text', text: `Your session is now named "${sessionState.sessionLabel}" in #${sessionState.channelName}. This name appears on every message you send.` }] };
    }

    case 'mcp_chat_instructions': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_connect first.' }], isError: true };
      }
      if (!sessionState.sessionInstructions) {
        return { content: [{ type: 'text', text: `No instructions are set for #${sessionState.channelName}. Set them with mcp_chat_set_instructions.` }] };
      }
      return { content: [{ type: 'text', text: `Channel instructions for #${sessionState.channelName}:\n${sessionState.sessionInstructions}` }] };
    }

    case 'mcp_chat_set_instructions': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_connect first.' }], isError: true };
      }
      if (typeof args.instructions !== 'string') {
        return { content: [{ type: 'text', text: 'instructions (string) is required. Pass an empty string to clear.' }], isError: true };
      }
      const instructions = args.instructions.slice(0, 10000);
      const result = await apiCall('set_channel_instructions', {
        channel_id: sessionState.channelId,
        instructions,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      sessionState.sessionInstructions = result.instructions || null;
      return { content: [{ type: 'text', text: result.instructions
        ? `Channel instructions for #${sessionState.channelName} updated. All connected sessions will see them.`
        : `Channel instructions for #${sessionState.channelName} cleared.` }] };
    }

    case 'mcp_chat_set_mode': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_connect first.' }], isError: true };
      }
      if (args.mode !== 'broadcast' && args.mode !== 'mention') {
        return { content: [{ type: 'text', text: "mode must be 'broadcast' or 'mention'." }], isError: true };
      }
      const result = await apiCall('set_channel_mode', {
        channel_id: sessionState.channelId,
        mode: args.mode,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      sessionState.deliveryMode = result.delivery_mode || args.mode;
      return { content: [{ type: 'text', text: sessionState.deliveryMode === 'mention'
        ? `#${sessionState.channelName} is now mentions-only: sessions are pushed only messages that @mention them; others can still mcp_chat_read. Browsers still see everything.`
        : `#${sessionState.channelName} is now broadcast: every message is pushed to every connected session.` }] };
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
          resources: {},
          experimental: { 'claude/channel': {} },
        },
        serverInfo: { name: 'mcp-chat-connect', version: LOCAL_VERSION },
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      sendResponse(id, { tools: getTools() });
      break;

    case 'resources/list':
      sendResponse(id, {
        resources: [
          {
            uri: STATUS_LINE_RESOURCE_URI,
            name: 'MCP Chat context status-line wrapper',
            description: 'One-time, idempotent install for a self-gating status-line wrapper that shares your live remaining-context % with other sessions in your channel.',
            mimeType: 'text/markdown',
          },
        ],
      });
      break;

    case 'resources/read': {
      const uri = params && params.uri;
      if (uri !== STATUS_LINE_RESOURCE_URI) {
        sendError(id, -32602, `Unknown resource: ${uri}`);
        break;
      }
      sendResponse(id, {
        contents: [
          {
            uri: STATUS_LINE_RESOURCE_URI,
            mimeType: 'text/markdown',
            text: buildStatusLineResourceText(),
          },
        ],
      });
      break;
    }

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
  clearSessionMarker();
  process.exit(0);
});

// Clean shutdown
process.on('SIGTERM', () => { disconnectWebSocket(); clearSessionMarker(); process.exit(0); });
process.on('SIGINT', () => { disconnectWebSocket(); clearSessionMarker(); process.exit(0); });
