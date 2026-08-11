'use strict';

/**
 * mcp-chat-connect watch -- block until this session is mentioned, then exit.
 *
 * Why this exists: pushed messages only reach a session that is actively
 * running. Claude Code in a terminal gets live delivery from the connector's own
 * WebSocket, but the Claude desktop app never passes
 * --dangerously-load-development-channels and offers no way to add it, so a
 * desktop session can send and read and still go deaf the moment it is idle.
 * The workaround that grew up around this is /loop, which spends a full model
 * turn on every wake whether or not anything is waiting.
 *
 * This is the cheap version of the same idea: run it as a BACKGROUND command.
 * It waits in shell, costing nothing while the channel is quiet, and exits the
 * moment the session is mentioned -- and a finished background command is what
 * brings the model back.
 *
 * Two deliberate design choices:
 *
 * 1. It connects to /ws WITHOUT a `session` parameter. That makes it a
 *    browser-class client: it receives every message in the channel even when
 *    the channel is in mention-only mode, it triggers no presence broadcast, and
 *    it writes no session row. It is an observer, not a second session, so it
 *    cannot collide with the label of the session it watches.
 *
 * 2. It is keyed on the session TOKEN, not the label. A label is mutable -- a
 *    human can rename a session from the browser sidebar -- and a watcher
 *    listening for a name its session no longer answers to is a watcher that
 *    reports silence forever. It resolves the label from the token at startup
 *    and follows session_renamed events for that token.
 *
 * Silence must never be ambiguous. Every way this can stop watching is a
 * distinct nonzero exit with a reason on stderr, so a quiet return means the
 * channel really was quiet:
 *
 *   0  you were mentioned (the message is printed to stdout)
 *   2  usage error
 *   3  cannot watch: auth rejected or expired
 *   4  cannot watch: connection went stale or could not be established
 *   5  nothing yet, re-arm me (hit --timeout)
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CONFIG_FILE = path.join(require('os').homedir(), '.mcp-chat', 'config.json');

// The server pings every 30s. Three missed pings means the socket is wedged --
// which looks exactly like a quiet channel, and is the failure this whole design
// exists to make impossible.
const STALE_AFTER_MS = 95000;

const EXIT = { MENTIONED: 0, USAGE: 2, AUTH: 3, STALE: 4, TIMEOUT: 5 };

function usage(message) {
  if (message) process.stderr.write(`mcp-chat watch: ${message}\n\n`);
  process.stderr.write(
    'Usage: mcp-chat-connect watch --channel <id> [--session <token> | --label <name>]\n' +
    '\n' +
    '  --channel <id>     Channel to watch (required).\n' +
    '  --session <token>  Session token to watch for mentions of. Preferred: it\n' +
    '                     survives a rename. Defaults to MCP_CHAT_SESSION_TOKEN.\n' +
    '  --label <name>     Watch for mentions of this name instead. Used only when\n' +
    '                     no session token is available.\n' +
    '  --timeout <mins>   Give up and exit 5 after this long (default 240, 0 = never).\n' +
    '  --any              Wake on any message, not only mentions.\n' +
    '\n' +
    'Exit codes: 0 mentioned, 2 usage, 3 auth, 4 stale connection, 5 timed out.\n'
  );
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const args = { timeoutMins: 240, any: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usage(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--channel') args.channelId = parseInt(next(), 10);
    else if (arg === '--session') args.sessionToken = next();
    else if (arg === '--label') args.label = next();
    // Fractional minutes are honored on purpose: parseInt would silently turn
    // --timeout 0.5 into "never time out", which is the one behavior a watcher
    // must not do by accident.
    else if (arg === '--timeout') args.timeoutMins = parseFloat(next());
    else if (arg === '--any') args.any = true;
    else if (arg === '--help' || arg === '-h') usage();
    else usage(`unknown argument ${arg}`);
  }
  return args;
}

/**
 * Does `content` mention `label`?
 *
 * Mirrors the server's resolveMentions and the browser's splitMentions: an @
 * on a word boundary, case-insensitive, and the character after the label must
 * not continue the word (so @QA does not match @QA Agent).
 */
function mentions(content, label) {
  if (!label) return false;
  const text = String(content || '');
  const needle = `@${label}`.toLowerCase();
  const haystack = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + needle.length] || '';
    if (!/\w/.test(before) && !/\w/.test(after)) return true;
    from = at + 1;
  }
}

function done(code, message, payload) {
  if (payload) process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function resolveLabel(baseUrl, token, channelId, sessionToken) {
  try {
    const res = await fetch(`${baseUrl}/mcp/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool: 'get_presence', args: { channel_id: channelId } }),
    });
    if (res.status === 401 || res.status === 403) return { error: `server rejected the saved token (HTTP ${res.status})` };
    const data = await res.json();
    if (data.error) return { error: data.error };
    const match = (data.sessions || []).find((s) => s.session_token === sessionToken);
    return { label: match ? match.label : null };
  } catch (err) {
    return { error: `could not reach ${baseUrl}: ${err.message}` };
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.channelId || Number.isNaN(args.channelId)) usage('--channel <id> is required');
  // Same trap as parseInt above: an unparseable --timeout must not quietly mean
  // "wait forever".
  if (Number.isNaN(args.timeoutMins)) usage('--timeout needs a number of minutes (0 means never)');

  const baseUrl = process.env.MCP_CHAT_URL;
  if (!baseUrl) usage('MCP_CHAT_URL is not set');

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  const token = process.env.MCP_CHAT_TOKEN || config.token;
  if (!token) {
    done(EXIT.AUTH, `No saved credentials at ${CONFIG_FILE}. Run mcp_chat_connect once in a Claude Code session first.`);
  }

  const sessionToken = args.sessionToken || process.env.MCP_CHAT_SESSION_TOKEN || null;
  let label = args.label || null;

  if (sessionToken) {
    const resolved = await resolveLabel(baseUrl, token, args.channelId, sessionToken);
    if (resolved.error) done(EXIT.AUTH, `Cannot watch: ${resolved.error}`);
    if (resolved.label) label = resolved.label;
  }
  if (!label && !args.any) {
    done(EXIT.USAGE, 'Nothing to watch for: pass --session with a token that is registered in this channel, or --label, or --any.');
  }

  const wsUrl = `${baseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/ws?token=${encodeURIComponent(token)}&channel=${args.channelId}`;
  const ws = new WebSocket(wsUrl);

  let lastActivity = Date.now();
  const staleTimer = setInterval(() => {
    if (Date.now() - lastActivity > STALE_AFTER_MS) {
      clearInterval(staleTimer);
      try { ws.close(); } catch {}
      done(EXIT.STALE, `Cannot watch: no traffic from the server for ${Math.round(STALE_AFTER_MS / 1000)}s, the connection is wedged. Re-run me.`);
    }
  }, 15000);

  if (args.timeoutMins > 0) {
    setTimeout(() => {
      try { ws.close(); } catch {}
      done(EXIT.TIMEOUT, `Nothing for ${args.timeoutMins} minutes. Still watching nothing -- re-run me to keep waiting.`);
    }, args.timeoutMins * 60000).unref?.();
  }

  ws.on('open', () => {
    lastActivity = Date.now();
    process.stderr.write(`Watching channel ${args.channelId} for ${args.any ? 'any message' : `mentions of "${label}"`}.\n`);
  });

  ws.on('ping', () => { lastActivity = Date.now(); });
  ws.on('pong', () => { lastActivity = Date.now(); });

  ws.on('message', (raw) => {
    lastActivity = Date.now();
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === 'session_renamed') {
      // Follow the token, not the name: a rename must not leave this watching
      // for a name nobody will use again.
      if (sessionToken && data.session_token === sessionToken && data.label) {
        process.stderr.write(`Session renamed to "${data.label}", now watching for that.\n`);
        label = data.label;
      }
      return;
    }

    if (data.type !== 'new_message') return;
    const msg = data.message || {};
    // Never wake on the watched session's own messages. user_name is shared
    // across all of one person's sessions, so it cannot be the discriminator.
    if (sessionToken && msg.session_id === sessionToken) return;

    if (args.any || mentions(msg.content, label)) {
      clearInterval(staleTimer);
      try { ws.close(); } catch {}
      const from = msg.session_id
        ? `${(msg.user_name || '').split(' ')[0]}'s Claude${msg.session_label ? ` (${msg.session_label})` : ''}`
        : msg.user_name || 'someone';
      done(EXIT.MENTIONED, null, {
        event: 'mentioned',
        channel_id: args.channelId,
        from,
        session_label: msg.session_label || null,
        content: msg.content,
        created_at: msg.created_at || null,
      });
    }
  });

  ws.on('close', (code) => {
    clearInterval(staleTimer);
    // 4001 is the server's invalid-token close. An expired token returning no
    // messages is indistinguishable from a quiet channel, so it must never be
    // allowed to look like one.
    if (code === 4001 || code === 1008) {
      done(EXIT.AUTH, 'Cannot watch: the saved token was rejected (expired or revoked). Run mcp_chat_connect again.');
    }
    done(EXIT.STALE, `Cannot watch: connection closed (code ${code}). Re-run me.`);
  });

  ws.on('error', (err) => {
    clearInterval(staleTimer);
    done(EXIT.STALE, `Cannot watch: ${err.message}`);
  });

  const stop = () => { try { ws.close(); } catch {}; done(EXIT.TIMEOUT, 'Stopped watching.'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { main, mentions, EXIT };
