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

// Subcommand dispatch, before any of the stdio-server setup below runs. `watch`
// is not an MCP server at all -- it is a blocking wait-for-mention used as a
// background command by surfaces that cannot receive live pushes (the Claude
// desktop app, which never passes --dangerously-load-development-channels).
if (process.argv[2] === 'watch') {
  require('./watch.js').main(process.argv.slice(3)).catch((err) => {
    process.stderr.write(`Cannot watch: ${err && err.message ? err.message : err}\n`);
    process.exit(4);
  });
  return;
}

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

/**
 * Channel notification meta is Record<string, string>. A non-string value makes
 * Claude Code drop the WHOLE notification with no error anywhere -- v1.5.0
 * shipped a boolean `mentioned` and every session on that version went silently
 * deaf until 1f702d9. Coerce rather than throw: a wrong-typed value should cost
 * a warning on stderr, never the message it was attached to.
 */
function normalizeMeta(meta) {
  const clean = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      clean[key] = value;
      continue;
    }
    process.stderr.write(`[mcp-chat] notification meta.${key} was ${typeof value}, coerced to string (meta must be all strings)\n`);
    clean[key] = String(value);
  }
  return clean;
}

function pushChannelMessage(source, content, meta) {
  sendNotification('notifications/claude/channel', {
    content,
    meta: normalizeMeta({ source, ...meta }),
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
let wsReconnectAttempts = 0;
// Highest message id pushed into this session's context. Sent as `since` on
// reconnect so the server replays only the gap, and used to drop a message that
// arrives both live and replayed -- which is legitimate for anything sent during
// the connect window.
let lastSeenMessageId = null;
const seenMessageIds = new Set();
// Bounded so a long-lived session in a busy channel does not grow this forever.
// Well above the server's 50-message replay cap, so a replayed batch is always
// checkable against it.
const SEEN_IDS_MAX = 500;
// Retries are 5s, 10s, 20s, 40s, 60s... so the 4th failure is roughly a minute
// of real downtime -- past a blip, worth telling the session about.
const WS_RECONNECT_WARN_AFTER = 4;

// A socket WE closed on purpose -- replaced by a newer one, or torn down on
// channel switch/shutdown. Its close event still fires, asynchronously, and
// without this marker the close handler cannot tell it apart from a connection
// that dropped underneath us. Marking beats removing the listener: the handler
// keeps its stderr line, and we stay out of the ws library's own listeners.
const WS_SUPERSEDED = Symbol('supersededByClient');
function markSuperseded(ws) {
  try { ws[WS_SUPERSEDED] = true; } catch {}
}

function connectWebSocket() {
  if (!sessionState.connected || !sessionState.token || !sessionState.channelId) return;

  // Any pending retry is now redundant -- we are connecting right here. Leaving it
  // armed is how a second, untracked reconnect chain gets started, and
  // wsReconnectTimeout holds only the newest one, so every chain but the last
  // becomes uncancellable.
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = null;
  }

  // Note: JWT is passed as a query parameter because WebSocket does not support custom headers.
  // Be aware this token may appear in server/proxy access logs.
  // Ask for what we missed while the socket was down. `since` is the highest
  // message id already handled; the server derives an anchor when it is absent.
  // Sending it at all is the opt-in -- the server stays silent for clients that
  // do not dedupe, which is every client published before this one.
  const sinceParam = lastSeenMessageId != null ? `&since=${lastSeenMessageId}` : '&replay=1';
  const wsUrl = `${MCP_CHAT_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/ws?token=${sessionState.token}&channel=${sessionState.channelId}&session=${sessionState.sessionToken}${sinceParam}`;

  // Superseding a socket we opened ourselves is a DELIBERATE close, and its close
  // handler must not read it as a dropped connection. Without this the replacement
  // socket's own arrival schedules a retry that closes the replacement five seconds
  // later, which schedules another: a permanent 5s connect/disconnect flap that
  // broadcasts a presence pair to the whole channel every cycle.
  if (wsConnection) {
    markSuperseded(wsConnection);
    try { wsConnection.close(); } catch {}
  }

  const ws = new WebSocket(wsUrl);
  wsConnection = ws;

  ws.on('open', () => {
    // Recovery is worth announcing only when the session was told delivery had
    // degraded, otherwise every routine blip becomes context noise.
    const wasDegraded = wsReconnectAttempts >= WS_RECONNECT_WARN_AFTER;
    wsReconnectAttempts = 0;
    sessionState.wsAuthFailed = false;
    process.stderr.write(`[mcp-chat] WebSocket connected to #${sessionState.channelName}\n`);
    if (wasDegraded) {
      pushChannelMessage('mcp-chat', `Live delivery for #${sessionState.channelName} is back. Anything sent while it was down was not pushed to you -- use mcp_chat_read to catch up.`, {
        channel: sessionState.channelName,
        event: 'delivery_restored',
      });
    }
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === 'replay') {
        // Header frame ahead of the missed messages. Worth surfacing only when
        // the gap was truncated, because then reading the channel is the ONLY
        // way to see the rest and silence would imply there was no rest.
        process.stderr.write(`[mcp-chat] replaying ${data.count} missed message(s) in #${sessionState.channelName}\n`);
        if (data.truncated_by) {
          pushChannelMessage('mcp-chat', `You missed more than can be replayed in #${sessionState.channelName} (cut off by ${data.truncated_by === 'age' ? 'age' : 'count'}). The most recent ${data.count} follow. Use mcp_chat_read for the rest.`, {
            channel: sessionState.channelName,
            event: 'replay_truncated',
            truncated_by: data.truncated_by,
          });
        }
        return;
      }

      if (data.type === 'new_message') {
        const msg = data.message;
        // Don't echo back messages sent by this Claude session itself
        // But DO receive messages from the same user's browser UI
        if (msg.session_id === sessionState.sessionToken) return;

        // A message sent during the connect window legitimately arrives twice --
        // once live, once in the replay. Dedupe on id so it is pushed once.
        if (msg.id != null) {
          if (seenMessageIds.has(msg.id)) return;
          seenMessageIds.add(msg.id);
          if (seenMessageIds.size > SEEN_IDS_MAX) {
            // Drop the oldest half rather than clearing: clearing would make the
            // very next replayed batch look unseen again.
            const ids = [...seenMessageIds].sort((a, b) => a - b);
            for (const id of ids.slice(0, Math.floor(ids.length / 2))) seenMessageIds.delete(id);
          }
          if (lastSeenMessageId == null || msg.id > lastSeenMessageId) lastSeenMessageId = msg.id;
        }

        const senderLabel = msg.session_id
          ? `${msg.user_name?.split(' ')[0]}'s Claude${msg.session_label ? ` (${msg.session_label})` : ''}`
          : msg.user_name || 'unknown';

        // In mentions-only channels, the server only delivers messages that @mention
        // this session and tags them mentioned:true -- flag it as a direct ping.
        // A replayed message says so, or it reads as something just said.
        const prefix = data.replay ? '[Missed while you were disconnected] ' : '';
        const content = data.mentioned
          ? `${prefix}[You were @mentioned] ${msg.content}`
          : `${prefix}${msg.content}`;

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
        // A human naming this session from the browser is a chosen name too, so it
        // carries into the next channel exactly like mcp_chat_set_name.
        sessionState.labelIsCustom = true;
        remoteSendSessions.clear(); // satellites carry the old name
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
        const renamed = data.name && data.name !== sessionState.channelName;
        if (renamed) sessionState.channelName = data.name;
        // A rename changes how this session must refer to the channel, so it is
        // worth a push. A description edit is not. Mentions-only means "do not
        // interrupt me unless I am addressed", which this was ignoring.
        if (renamed && sessionState.deliveryMode !== 'mention') {
          pushChannelMessage('mcp-chat', `Channel renamed to #${data.name}${data.description ? ` -- ${data.description}` : ''}${data.updated_by ? ` by ${data.updated_by}` : ''}.`, {
            channel: sessionState.channelName,
            event: 'channel_updated',
          });
        }
      } else if (data.type === 'presence') {
        // Presence is a pull, not a push: who else is connected right now is
        // rarely actionable, it arrives for every session of every member, and
        // mcp_chat_presence answers it on demand. Only surface it in broadcast
        // mode, where the session has asked for everything.
        if (!data.session_token) return; // browser refreshes are not sessions
        if (data.user_id === sessionState.userId) return; // never our own
        if (sessionState.deliveryMode === 'mention') return;

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

  ws.on('close', (code) => {
    // A close we caused is not a connection we lost. Retrying on its behalf
    // resurrects a link the session deliberately dropped -- and because 'open'
    // resets wsReconnectAttempts to 0, the backoff never grows out of the loop it
    // creates. `wsConnection !== ws` catches any socket that reaches here without
    // the marker (it is always reassigned or nulled before the event fires).
    if (ws[WS_SUPERSEDED] || wsConnection !== ws) {
      process.stderr.write(`[mcp-chat] WebSocket closed by client (code ${code}), not reconnecting.\n`);
      return;
    }

    // 4001 is the server's invalid-token close. Retrying it is pointless -- the
    // token will not become valid -- and worse, the session goes on believing it
    // is connected: sends still fail loudly, but receives fail silently, so a
    // channel that has gone deaf is indistinguishable from a quiet one. Say so
    // in Claude's context, which is the only place anyone is actually reading.
    if (code === 4001 || code === 1008) {
      sessionState.wsAuthFailed = true;
      process.stderr.write('[mcp-chat] WebSocket rejected: token expired or revoked. Not retrying.\n');
      pushChannelMessage('mcp-chat', `Live delivery for #${sessionState.channelName} has STOPPED: the saved MCP Chat token was rejected (expired or revoked). You are no longer being pushed messages, and silence from this channel now means nothing. Run mcp_chat_join with authorize: true to re-authenticate.`, {
        channel: sessionState.channelName,
        event: 'auth_failed',
      });
      return;
    }

    // Back off rather than hammering /ws every 5s forever. Capped so a long
    // outage still recovers on its own, and announced once when it stops being
    // a blip, because an unannounced reconnect loop looks exactly like a quiet
    // channel from inside the session.
    wsReconnectAttempts += 1;
    const delay = Math.min(5000 * 2 ** (wsReconnectAttempts - 1), 60000);
    process.stderr.write(`[mcp-chat] WebSocket disconnected (code ${code}), reconnecting in ${delay / 1000}s (attempt ${wsReconnectAttempts})...\n`);
    if (wsReconnectAttempts === WS_RECONNECT_WARN_AFTER) {
      pushChannelMessage('mcp-chat', `Live delivery for #${sessionState.channelName} has been down for several minutes and is still retrying. Messages sent in the meantime are not being pushed to you. Use mcp_chat_read to catch up, and mcp_chat_join (no arguments) to check the connection.`, {
        channel: sessionState.channelName,
        event: 'delivery_degraded',
      });
    }
    wsReconnectTimeout = setTimeout(connectWebSocket, delay);
  });

  ws.on('error', (err) => {
    process.stderr.write(`[mcp-chat] WebSocket error: ${err.message}\n`);
  });
}

function disconnectWebSocket() {
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = null;
  }
  if (wsConnection) {
    // close() is asynchronous: the close event fires AFTER this function returns,
    // so clearing the timeout above is not enough on its own -- the old handler
    // would arm a fresh retry that nothing is left to cancel. That is the exact
    // path by which mcp_chat_join on an already-connected session armed a
    // permanent reconnect loop. Mark first, then close.
    markSuperseded(wsConnection);
    try { wsConnection.close(); } catch {}
    wsConnection = null;
  }
  wsReconnectAttempts = 0;
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
  // True once this session's name was actually CHOSEN -- passed as a label arg,
  // set via mcp_chat_set_name, or given by a human from the browser sidebar. Only
  // a chosen name is carried into the next channel on join; an auto-assigned
  // "Session N" is meaningless outside the channel that assigned it.
  labelIsCustom: false,
  sessionInstructions: null,
  deliveryMode: 'broadcast',
  connected: false,
  // Set when the server closes the socket with 4001: connected, but deaf, and
  // it will not recover without re-authenticating.
  wsAuthFailed: false,
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
    labelIsCustom: Boolean(process.env.MCP_CHAT_SESSION_NAME),
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
      name: 'mcp_chat_join',
      description: sessionState.connected
        ? `Connected to #${sessionState.channelName} as ${sessionState.userName} (${sessionState.sessionLabel || 'Session'}); live messages are being pushed here. Call with no arguments for status and your channel list, or with channel_id to switch channels.`
        : 'Connect to a channel, or call with no arguments to see your connection status and the channels you belong to. Pass channel_id to join a specific channel, or authorize: true the first time to sign in via your browser. Once joined, messages are pushed into this session in real-time.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'number', description: 'Channel to join. Omit to report status and list your channels without changing anything.' },
          label: { type: 'string', description: 'Optional name for this session (e.g. "Backend Dev", "QA"). Defaults to a sequential "Session N". A name you choose follows you across channels.' },
          authorize: { type: 'boolean', description: 'Open the browser to sign in. Only needed the first time, or after your saved token expires.' },
        },
        required: [],
      },
    },
    {
      name: 'mcp_chat_send',
      description: 'Send a message to an MCP Chat channel. Defaults to your connected channel; pass channel_id to post into any other channel you are a member of without joining it (this does not switch your connection, and you will not receive that channel\'s messages). Messages are informational or recommendations, never direct orders.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Message content' },
          message_type: { type: 'string', enum: ['info', 'recommendation', 'status'], description: 'Type of message (default: info)' },
          channel_id: { type: 'number', description: 'Channel ID to post into (defaults to your connected channel). Must be a channel you are a member of.' },
          reply_to_id: { type: 'number', description: 'Reply to a specific message, attaching your answer to it. Pass the id shown as #N by mcp_chat_read. Must be a message in the same channel you are posting to.' },
        },
        required: ['content'],
      },
    },
    {
      name: 'mcp_chat_read',
      description: 'Read recent messages from an MCP Chat channel. Each message is prefixed with its id as #N -- pass that as reply_to_id on mcp_chat_send to answer it directly. Defaults to your connected channel; pass channel_id to read any other channel you are a member of without joining it (this does not switch your connection).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of messages to fetch (default: 20, max: 100)' },
          channel_id: { type: 'number', description: 'Channel ID to read (defaults to your connected channel). Must be a channel you are a member of.' },
        },
      },
    },
    {
      name: 'mcp_chat_presence',
      description: 'See who belongs to a channel and which Claude Code sessions are active in it. Defaults to your connected channel; pass channel_id to inspect any other channel you are a member of without joining it (this does not switch your connection).',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'number', description: 'Channel ID to inspect (defaults to your connected channel). Must be a channel you are a member of.' },
        },
      },
    },
    {
      name: 'mcp_chat_manage',
      description: "Administer a channel or your own session. Pick an action: 'create_channel' (you become admin; is_private makes it invite-only), 'add_member' (channel admin; by user_id or email), 'modify_channel' (channel admin; name/description/is_private), 'set_name' (rename your own session; the name follows you across channels), 'get_instructions' / 'set_instructions' (the channel's shared system prompt, any member, empty string clears), 'set_mode' ('broadcast' pushes every message to every session, 'mention' pushes only to @<session-name>-mentioned sessions; browsers always see everything).",
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create_channel', 'add_member', 'modify_channel', 'set_name', 'get_instructions', 'set_instructions', 'set_mode'],
            description: 'What to do.',
          },
          channel_id: { type: 'number', description: 'Channel to act on (defaults to your connected channel). Used by add_member and modify_channel.' },
          name: { type: 'string', description: 'For create_channel and modify_channel, the channel name. For set_name, the name for this session.' },
          description: { type: 'string', description: 'Channel description, for create_channel and modify_channel.' },
          member_ids: { type: 'array', items: { type: 'number' }, description: 'User IDs to add as members, for create_channel.' },
          is_private: { type: 'boolean', description: 'Invite-only: hidden from and inaccessible to non-members, including admins. For create_channel and modify_channel.' },
          user_id: { type: 'number', description: 'User to add, for add_member.' },
          email: { type: 'string', description: 'Email of the user to add, for add_member (alternative to user_id).' },
          instructions: { type: 'string', description: "The channel's shared instructions, for set_instructions. Empty string clears them." },
          mode: { type: 'string', enum: ['broadcast', 'mention'], description: "Delivery mode, for set_mode." },
        },
        required: ['action'],
      },
    },
  ];
}

/**
 * Public action name -> the internal handler that already implements it.
 *
 * The handlers are unchanged and still keyed by their original names. That is
 * deliberate: several carry side effects that an action-enum rewrite is exactly
 * the kind of refactor that loses. set_name, for one, sets the flag that makes a
 * chosen name follow the session across joins -- rename the case body and that
 * behaviour goes quiet rather than failing.
 */
/**
 * Names removed in 2.0.0, and where their behaviour went. Callers include live
 * channel `instructions` rows and shell aliases written months ago, none of which
 * this release can reach -- so the error has to carry the migration itself.
 */
const RETIRED_TOOLS = {
  mcp_chat_connect: "Use mcp_chat_join with authorize: true to sign in, or with a channel_id to switch channels.",
  mcp_chat_status: 'Use mcp_chat_join with no arguments.',
  mcp_chat_channels: 'Use mcp_chat_join with no arguments; it lists your channels alongside your status.',
  mcp_chat_create_channel: "Use mcp_chat_manage with action: 'create_channel'.",
  mcp_chat_add_member: "Use mcp_chat_manage with action: 'add_member'.",
  mcp_chat_modify_channel: "Use mcp_chat_manage with action: 'modify_channel'.",
  mcp_chat_set_name: "Use mcp_chat_manage with action: 'set_name'.",
  mcp_chat_instructions: "Use mcp_chat_manage with action: 'get_instructions'.",
  mcp_chat_set_instructions: "Use mcp_chat_manage with action: 'set_instructions'.",
  mcp_chat_set_mode: "Use mcp_chat_manage with action: 'set_mode'.",
};

const MANAGE_ACTIONS = {
  create_channel: 'mcp_chat_create_channel',
  add_member: 'mcp_chat_add_member',
  modify_channel: 'mcp_chat_modify_channel',
  set_name: 'mcp_chat_set_name',
  get_instructions: 'mcp_chat_instructions',
  set_instructions: 'mcp_chat_set_instructions',
  set_mode: 'mcp_chat_set_mode',
};

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

/**
 * Resolve which channel a tool should act on.
 *
 * No channel_id means the connected channel. An explicit channel_id is looked up
 * in the caller's channel list, so a channel that does not exist -- or that this
 * user is not a member of -- is an error rather than a silent fallback to the
 * connected channel. Membership is enforced server-side regardless (get_messages
 * 403s a non-member); this lookup exists to give a useful message and the name.
 *
 * Returns { id, name } or { error }.
 */
async function resolveChannel(channelIdArg) {
  if (channelIdArg === undefined || channelIdArg === null || channelIdArg === '') {
    if (!sessionState.connected) {
      return { error: 'Not connected. Run mcp_chat_join first, or pass channel_id to read a specific channel.' };
    }
    return { id: sessionState.channelId, name: sessionState.channelName };
  }

  const channelId = parseInt(channelIdArg, 10);
  if (!channelId || isNaN(channelId)) {
    return { error: 'Valid channel_id is required.' };
  }
  if (channelId === sessionState.channelId && sessionState.channelName) {
    return { id: channelId, name: sessionState.channelName }; // already resolved; skip the roundtrip
  }
  if (!sessionState.token) {
    return { error: 'Not authenticated. Run mcp_chat_join with authorize: true first.' };
  }

  const channelsResult = await apiCall('list_channels', {}, sessionState.token);
  const channel = channelsResult.channels?.find(c => c.id === channelId);
  if (!channel) {
    return { error: `Channel ${channelId} not found or you are not a member.` };
  }
  return { id: channel.id, name: channel.name };
}

/**
 * Session identities used to post into channels this session is not connected to.
 * Keyed by channel id. Cleared whenever the session's own identity changes, so a
 * satellite token derived from a previous sessionToken is never reused.
 */
const remoteSendSessions = new Map();

/**
 * Resolve the session identity to stamp on a message in `target`.
 *
 * Every message carries a session_label joined from the sessions table, and a
 * session row is per channel (session_token is unique, so one row cannot span
 * two channels). Posting into a channel this session never joined therefore has
 * no identity to stamp -- so register a satellite session there, under a derived
 * token, with connected: false. It gets a label of its own (the chosen name when
 * this session has one, otherwise that channel's next "Session N") without
 * moving the connection or appearing as an active session in that channel.
 */
async function resolveSendIdentity(target) {
  if (target.id === sessionState.channelId) {
    if (!sessionState.connected) {
      return { error: 'Not connected. Run mcp_chat_join first, or pass channel_id to post into a specific channel.' };
    }
    return { sessionToken: sessionState.sessionToken, label: sessionState.sessionLabel };
  }

  const cached = remoteSendSessions.get(target.id);
  if (cached) return cached;

  if (!sessionState.sessionToken) {
    return { error: 'No session identity yet. Run mcp_chat_join first.' };
  }

  const remoteToken = `${sessionState.sessionToken}-ch${target.id}`;
  const registerArgs = {
    channel_id: target.id,
    session_token: remoteToken,
    connected: false,
  };
  // Only a CHOSEN name travels. An auto-assigned "Session N" names a slot in the
  // channel that issued it, so the target channel allocates its own.
  if (sessionState.labelIsCustom && sessionState.sessionLabel) {
    registerArgs.label = sessionState.sessionLabel;
  }

  const result = await apiCall('register_session', registerArgs, sessionState.token);
  if (result.error) return { error: result.error };

  // The server suffixes a requested label that is already taken, so the returned
  // label is authoritative.
  const identity = { sessionToken: remoteToken, label: result.label };
  remoteSendSessions.set(target.id, identity);
  return identity;
}

/**
 * Reject argument keys a tool does not declare.
 *
 * Without this, an undeclared argument is silently dropped and the tool answers
 * about something else -- a caller asking for channel 688 got channel 693's
 * messages presented as the answer, with no indication anything was discarded.
 * A wrong answer that looks like a right one is worse than an error.
 */
function validateToolArgs(name, args) {
  const tool = getTools().find(t => t.name === name);
  if (!tool) return null;
  const allowed = Object.keys(tool.inputSchema?.properties || {});
  const unknown = Object.keys(args || {}).filter(k => !allowed.includes(k));
  if (unknown.length === 0) return null;
  const accepted = allowed.length ? allowed.join(', ') : 'none';
  // Also to stderr: if a host ever injects a key of its own, this is what makes a
  // spurious rejection diagnosable from a single bug report.
  process.stderr.write(`[mcp-chat] rejected unknown argument(s) for ${name}: ${unknown.join(', ')}\n`);
  return `Unknown argument${unknown.length > 1 ? 's' : ''} for ${name}: ${unknown.join(', ')}. Accepted arguments: ${accepted}.`;
}

/**
 * Public tool surface (5 tools) on top of the internal handlers (14).
 *
 * Every session that registers this server loads every advertised tool into its
 * context whether or not it ever uses chat, so the surface is the cost. The
 * handlers below are untouched -- only what is advertised changed -- because the
 * risk in this refactor was never the routing, it was losing a side effect
 * buried in a handler nobody re-read.
 */
async function handleToolCall(name, args) {
  const argError = validateToolArgs(name, args);
  if (argError) {
    return { content: [{ type: 'text', text: argError }], isError: true };
  }

  switch (name) {
    case 'mcp_chat_join': {
      // Explicitly authorizing is the ONLY path that opens a browser. Asking
      // "am I connected?" must never pop one: status is how a session learns its
      // own channel id and token to arm a watcher, and how it tells a rejected
      // token from a reconnect in progress. A read that has a side effect is not
      // a read anyone can safely call.
      if (args?.authorize) {
        return dispatchTool('mcp_chat_connect', { label: args.label });
      }
      if (args?.channel_id !== undefined && args?.channel_id !== null) {
        return dispatchTool('mcp_chat_join', { channel_id: args.channel_id, label: args.label });
      }
      if (!sessionState.token) {
        return {
          content: [{
            type: 'text',
            text: 'Not connected, and there are no saved credentials on this machine.\n\nRun mcp_chat_join with authorize: true to sign in (this opens your browser).',
          }],
        };
      }
      // Status and the channel list answer one question -- "where am I and where
      // could I go" -- and were two tools purely because they were written apart.
      const status = await dispatchTool('mcp_chat_status', {});
      const channels = await dispatchTool('mcp_chat_channels', {});
      return {
        content: [{ type: 'text', text: `${status.content[0].text}\n\n${channels.content[0].text}` }],
      };
    }

    case 'mcp_chat_manage': {
      const internal = MANAGE_ACTIONS[args?.action];
      if (!internal) {
        return {
          content: [{
            type: 'text',
            text: `Unknown action: ${args?.action}. Valid actions: ${Object.keys(MANAGE_ACTIONS).join(', ')}.`,
          }],
          isError: true,
        };
      }
      const { action, ...rest } = args || {};
      return dispatchTool(internal, rest);
    }

    default: {
      // A retired name must fail loudly, not quietly work. Two reasons: the
      // internal handlers are still present, so an old name would otherwise fall
      // straight through and keep functioning, which is not the clean break this
      // release claims; and validateToolArgs only validates ADVERTISED tools, so
      // anything arriving under an unadvertised name gets its arguments accepted
      // unchecked -- the exact silent-drop class that mcp_chat_read's channel bug
      // came from. Naming the replacement makes the migration a one-line fix.
      if (!getTools().some(t => t.name === name)) {
        const hint = RETIRED_TOOLS[name];
        return {
          content: [{
            type: 'text',
            text: hint
              ? `${name} no longer exists in mcp-chat-connect 2.x. ${hint}`
              : `Unknown tool: ${name}. Available tools: ${getTools().map(t => t.name).join(', ')}.`,
          }],
          isError: true,
        };
      }
      return dispatchTool(name, args);
    }
  }
}

/**
 * The internal handlers. Reached only through handleToolCall, which has already
 * validated the caller's arguments against the advertised schema.
 */
async function dispatchTool(name, args) {
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
          labelIsCustom: Boolean(args.label),
          sessionInstructions: null,
          deliveryMode: 'broadcast',
          connected: true,
        };
        remoteSendSessions.clear(); // satellite tokens are derived from sessionToken
        // Message ids are global, so a cursor from the previous channel would
        // skip anything older in this one. Drop it and let the server derive
        // the anchor from this session's row in the channel it just entered.
        lastSeenMessageId = null;
        seenMessageIds.clear();
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
        let responseText = `Connected to #${result.channelName} as ${result.userName} (${sessionLabel}). Your session is named "${sessionLabel}" -- this name appears on every message you send. Use mcp_chat_manage with action 'set_name' to change it. Live messages will now be pushed into this session. You can also use mcp_chat_send to send messages and mcp_chat_read to fetch history.`;
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
        return { content: [{ type: 'text', text: 'Not authenticated. A user must run mcp_chat_join with authorize: true first to save credentials.' }], isError: true };
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

        // A name this session actually chose follows it into the new channel, so one
        // session keeps one identity across channels instead of picking up a fresh
        // auto-assigned number in each. An explicit label arg still wins. An
        // auto-assigned "Session N" is deliberately NOT carried: it names a slot in
        // the channel that issued it, not this session.
        const carriedLabel = sessionState.labelIsCustom ? sessionState.sessionLabel : null;
        const requestedLabel = args.label || carriedLabel || undefined;

        // If this session already posted into the channel it is now joining, it left
        // a satellite row there. Hand it to the server to supersede: left in place it
        // would make the allocator treat this session's own name as taken and hand
        // back a suffixed one, so the act of having sent would rename it on arrival.
        const satelliteToken = remoteSendSessions.get(channelId)?.sessionToken || undefined;

        disconnectWebSocket();
        const sessionToken = `mcp-${crypto.randomBytes(16).toString('hex')}`;
        sessionState = {
          ...sessionState,
          channelId,
          channelName: channel.name,
          sessionToken,
          sessionLabel: null,
          labelIsCustom: Boolean(requestedLabel),
          sessionInstructions: null,
          deliveryMode: channel.delivery_mode || 'broadcast',
          connected: true,
        };
        remoteSendSessions.clear(); // satellite tokens are derived from sessionToken
        // Message ids are global, so a cursor from the previous channel would
        // skip anything older in this one. Drop it and let the server derive
        // the anchor from this session's row in the channel it just entered.
        lastSeenMessageId = null;
        seenMessageIds.clear();

        // Register session to get label (custom or sequential) + channel instructions.
        // The server may suffix a requested label that is already taken in the target
        // channel, so the returned label is authoritative -- never assume we got the
        // name we asked for.
        let sessionLabel = requestedLabel || 'Session';
        try {
          const regResult = await apiCall('register_session', {
            channel_id: channelId,
            session_token: sessionToken,
            label: requestedLabel,
            supersede_token: satelliteToken,
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
        let joinText = `Joined #${channel.name} (ID: ${channelId}) as ${sessionState.userName} (${sessionLabel}). Your session is named "${sessionLabel}"; use mcp_chat_manage with action 'set_name' to change it. Live messages are now being pushed.`;
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
      const target = await resolveChannel(args.channel_id);
      if (target.error) return { content: [{ type: 'text', text: target.error }], isError: true };

      const content = String(args.content || '').slice(0, 10000);
      if (!content) return { content: [{ type: 'text', text: 'Message content is required.' }], isError: true };
      const messageType = ['info', 'recommendation', 'status'].includes(args.message_type) ? args.message_type : 'info';

      const identity = await resolveSendIdentity(target);
      if (identity.error) return { content: [{ type: 'text', text: `Error: ${identity.error}` }], isError: true };

      // Omitted rather than sent as null when absent: the server treats an absent
      // reply_to_id as "not a reply", and sending null on every ordinary message
      // would put a nullable field through the same-channel validation path for
      // no reason.
      const replyToId = args.reply_to_id === undefined || args.reply_to_id === null
        ? undefined
        : parseInt(args.reply_to_id, 10);
      if (replyToId !== undefined && isNaN(replyToId)) {
        return { content: [{ type: 'text', text: 'reply_to_id must be a message id (the number shown as #N by mcp_chat_read).' }], isError: true };
      }

      const result = await apiCall('send_message', {
        channel_id: target.id,
        content,
        message_type: messageType,
        session_token: identity.sessionToken,
        ...(replyToId !== undefined ? { reply_to_id: replyToId } : {}),
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      const sendNote = target.id === sessionState.channelId
        ? `Message sent to #${target.name}`
        : `Message sent to #${target.name} (ID: ${target.id}) as "${identity.label}" -- you are still connected to #${sessionState.channelName} and will not receive replies there.`;
      return { content: [{ type: 'text', text: sendNote }] };
    }

    case 'mcp_chat_read': {
      // Reading another channel needs credentials, not a connection -- being
      // connected is only required when falling back to the connected channel.
      const target = await resolveChannel(args.channel_id);
      if (target.error) return { content: [{ type: 'text', text: target.error }], isError: true };

      const limit = Math.max(1, Math.min(100, parseInt(args.limit, 10) || 20));
      const result = await apiCall('get_messages', {
        channel_id: target.id,
        limit,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      if (!result.messages || result.messages.length === 0) {
        return { content: [{ type: 'text', text: `No messages in #${target.name}` }] };
      }
      const formatted = result.messages.map(m => {
        const sender = m.session_id
          ? `${m.user_name?.split(' ')[0]}'s Claude${m.session_label ? ` (${m.session_label})` : ''}`
          : m.user_name;
        // The id is what makes a message targetable. Without it in the output a
        // session can read a channel but has no handle to reply to anything in it.
        const id = m.id ? `#${m.id} ` : '';
        const replyMark = m.reply_to_id
          ? ` [replying to #${m.reply_to_id}: "${String(m.reply_to_content || '').slice(0, 60)}..."]`
          : '';
        return `${id}[${new Date(m.created_at).toLocaleTimeString()}] ${sender}${replyMark}: ${m.content}`;
      }).join('\n');
      const readHeader = target.id === sessionState.channelId
        ? `Messages in #${target.name}:`
        : `Messages in #${target.name} (ID: ${target.id}) -- you are still connected to #${sessionState.channelName}:`;
      return { content: [{ type: 'text', text: `${readHeader}\n${formatted}` }] };
    }

    case 'mcp_chat_presence': {
      // Same contract as mcp_chat_read: inspecting another channel needs
      // credentials, not a connection, and never moves the session.
      const target = await resolveChannel(args.channel_id);
      if (target.error) return { content: [{ type: 'text', text: target.error }], isError: true };

      const result = await apiCall('get_presence', { channel_id: target.id }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };

      const sections = [];
      if (result.members && result.members.length > 0) {
        sections.push(`Members (${result.members.length}):\n` + result.members.map(m =>
          `- ${m.user_name}${m.role === 'admin' ? ' (channel admin)' : ''}`
        ).join('\n'));
      }
      if (result.sessions && result.sessions.length > 0) {
        sections.push('Active sessions:\n' + result.sessions.map(s =>
          `- ${s.user_name} (${s.label || 'Claude session'}) ${s.is_connected ? 'online' : 'offline'}${s.context_remaining_pct != null ? ` -- context: ${s.context_remaining_pct}%` : ''}`
        ).join('\n'));
      } else {
        sections.push('Active sessions: none');
      }

      const presenceHeader = target.id === sessionState.channelId
        ? `#${target.name}:`
        : `#${target.name} (ID: ${target.id}) -- you are still connected to #${sessionState.channelName}:`;
      return { content: [{ type: 'text', text: `${presenceHeader}\n${sections.join('\n\n')}` }] };
    }

    case 'mcp_chat_channels': {
      if (!sessionState.token) {
        return { content: [{ type: 'text', text: 'Not authenticated. Run mcp_chat_join with authorize: true first.' }], isError: true };
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
        return { content: [{ type: 'text', text: sessionState.token ? 'Authenticated but not connected to a channel. Run mcp_chat_join with a channel_id to pick one.' : 'Not connected. Run mcp_chat_join with authorize: true to sign in and pick a channel.' }] };
      }
      // Do not report a wedged or rejected socket as "reconnecting" -- that reads
      // as temporary, and an expired token never recovers on its own.
      const wsStatus = sessionState.wsAuthFailed
        ? 'NOT receiving: token rejected (expired or revoked). Run mcp_chat_join with authorize: true to re-authenticate.'
        : wsConnection?.readyState === 1
          ? 'live (receiving messages)'
          : `not receiving, reconnecting (attempt ${wsReconnectAttempts})`;
      const modeText = sessionState.deliveryMode === 'mention'
        ? `mentions-only (you are pushed only messages that @mention "${sessionState.sessionLabel || 'your session'}"; use mcp_chat_read for the rest)`
        : 'broadcast (you are pushed every message)';
      // Channel id and session token are reported because a session cannot
      // otherwise learn its own identity, and both are needed to arm the
      // background watcher (`mcp-chat-connect watch`) on surfaces that get no
      // live push.
      let statusText = `Connected to #${sessionState.channelName} (ID: ${sessionState.channelId}) as ${sessionState.userName} (${sessionState.sessionLabel || 'Session'})\nSession token: ${sessionState.sessionToken}\nWebSocket: ${wsStatus}\nDelivery: ${modeText}`;
      if (sessionState.sessionInstructions) {
        statusText += `\n\nChannel instructions:\n${sessionState.sessionInstructions}`;
      }
      return { content: [{ type: 'text', text: statusText }] };
    }

    case 'mcp_chat_create_channel': {
      if (!sessionState.token) {
        return { content: [{ type: 'text', text: 'Not authenticated. Run mcp_chat_join with authorize: true first.' }], isError: true };
      }
      const channelName = String(args.name || '').trim();
      if (!channelName) return { content: [{ type: 'text', text: 'Channel name is required.' }], isError: true };
      const result = await apiCall('create_channel', {
        name: channelName,
        description: args.description || null,
        member_ids: args.member_ids || [],
        is_private: args.is_private === true,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text', text: `${result.channel.is_private ? 'Private channel' : 'Channel'} #${result.channel.name} created (ID: ${result.channel.id})${result.channel.description ? ` -- ${result.channel.description}` : ''}` }] };
    }

    case 'mcp_chat_add_member': {
      if (!sessionState.token) {
        return { content: [{ type: 'text', text: 'Not authenticated. Run mcp_chat_join with authorize: true first.' }], isError: true };
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
        return { content: [{ type: 'text', text: 'Not authenticated. Run mcp_chat_join with authorize: true first.' }], isError: true };
      }
      const channelId = args.channel_id || sessionState.channelId;
      if (!channelId) return { content: [{ type: 'text', text: 'No channel specified and not connected to one.' }], isError: true };
      const result = await apiCall('modify_channel', {
        channel_id: channelId,
        name: args.name || undefined,
        description: args.description !== undefined ? args.description : undefined,
        is_private: args.is_private !== undefined ? args.is_private : undefined,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Channel updated: ${result.channel.is_private ? '(private) ' : ''}#${result.channel.name}${result.channel.description ? ` -- ${result.channel.description}` : ''}` }] };
    }

    case 'mcp_chat_set_name': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_join first.' }], isError: true };
      }
      const newName = String(args.name || '').trim().slice(0, 100);
      if (!newName) return { content: [{ type: 'text', text: 'A name is required.' }], isError: true };
      const result = await apiCall('rename_session', {
        session_token: sessionState.sessionToken,
        label: newName,
      }, sessionState.token);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      // The server suffixes a name already taken in this channel, so use what it returned.
      sessionState.sessionLabel = result.label || newName;
      sessionState.labelIsCustom = true;
      // Satellites were registered under the OLD name, so drop them: the next
      // cross-channel send re-registers under the new one rather than stamping a
      // name this session no longer answers to.
      remoteSendSessions.clear();
      let renameText = `Your session is now named "${sessionState.sessionLabel}" in #${sessionState.channelName}. This name appears on every message you send, and it now follows you into any channel you join.`;
      if (sessionState.sessionLabel !== newName) {
        renameText += ` (You asked for "${newName}", which another session in this channel already uses.)`;
      }
      return { content: [{ type: 'text', text: renameText }] };
    }

    case 'mcp_chat_instructions': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_join first.' }], isError: true };
      }
      if (!sessionState.sessionInstructions) {
        return { content: [{ type: 'text', text: `No instructions are set for #${sessionState.channelName}. Set them with mcp_chat_manage, action 'set_instructions'.` }] };
      }
      return { content: [{ type: 'text', text: `Channel instructions for #${sessionState.channelName}:\n${sessionState.sessionInstructions}` }] };
    }

    case 'mcp_chat_set_instructions': {
      if (!sessionState.connected) {
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_join first.' }], isError: true };
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
        return { content: [{ type: 'text', text: 'Not connected. Run mcp_chat_join first.' }], isError: true };
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
