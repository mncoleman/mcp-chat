#!/usr/bin/env node
'use strict';

/*
 * mcp-chat context status-line wrapper
 * ------------------------------------
 * A self-gating wrapper around your Claude Code status line.
 *
 * On every status-line tick Claude Code pipes a JSON blob to this script on
 * stdin. This wrapper does two things, in this order of priority:
 *
 *   1. ALWAYS passes the SAME stdin through to your original ("upstream")
 *      status-line command and streams its stdout straight to Claude Code, so
 *      your status line is never blank and never delayed. If no upstream was
 *      chained at install time, it prints a minimal default line instead.
 *
 *   2. ONLY IF a fresh mcp-chat session marker exists, it fire-and-forgets a
 *      POST of your remaining-context % to the mcp-chat server so other agents
 *      in your channel can see it. The POST never blocks or delays (1) and
 *      swallows every error. When the marker is missing or stale (>15 min old,
 *      i.e. you are not currently connected to mcp-chat), it does nothing.
 *
 * Because the gate is the marker file -- not a Claude Code hook -- teardown is
 * crash-safe: if a session dies without cleaning up, its marker goes stale and
 * this wrapper simply stops reporting. No SessionEnd hook required.
 *
 * This file is safe to leave installed permanently. It is written to
 * ~/.mcp-chat/status-line-wrapper.js by the one-time install step (see the MCP
 * resource "mcp-chat://status-line-wrapper" or skills/mcp-chat-context/SKILL.md).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.mcp-chat');
const MARKER_FILE = path.join(CONFIG_DIR, 'active-session.json');
const WRAPPER_CONFIG_FILE = path.join(CONFIG_DIR, 'status-line-config.json');

const MARKER_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes -> treat older markers as stale
const POST_TIMEOUT_MS = 1500;

// ─── stdin: collect the entire status-line payload verbatim ──────────────────
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    run(raw);
  } catch {
    // Last-resort: never leave the status line broken.
    try { process.stdout.write(raw ? '' : '\n'); } catch {}
  }
});
process.stdin.on('error', () => { try { run(raw); } catch {} });

function run(input) {
  let parsed = null;
  try { parsed = JSON.parse(input); } catch {}

  // (2) Best-effort context report -- started FIRST so it overlaps with the
  // upstream command's runtime, and fully decoupled from the passthrough.
  try { maybeReportContext(parsed); } catch {}

  // (1) Passthrough -- the user's status line, always.
  try { passthrough(input, parsed); } catch { printDefault(parsed); }
}

// ─── (1) Passthrough to the upstream status-line command ─────────────────────
function passthrough(input, parsed) {
  const upstream = loadUpstreamCommand();
  if (!upstream) {
    printDefault(parsed);
    return;
  }

  // Claude Code's statusLine is a shell command; run it via the shell so we
  // honour the exact command string the user had configured.
  const child = spawn(upstream, {
    shell: true,
    stdio: ['pipe', 'inherit', 'ignore'],
  });

  child.on('error', () => printDefault(parsed));
  try {
    child.stdin.write(input);
    child.stdin.end();
  } catch {
    // If we cannot feed it, fall back so the line is never blank.
    try { child.kill(); } catch {}
    printDefault(parsed);
  }
}

function loadUpstreamCommand() {
  try {
    const cfg = JSON.parse(fs.readFileSync(WRAPPER_CONFIG_FILE, 'utf8'));
    const up = cfg && cfg.upstream;
    if (!up) return null;
    // upstream may be stored as a raw command string or as a Claude Code
    // statusLine object { type:'command', command:'...' }.
    if (typeof up === 'string') return up.trim() || null;
    if (typeof up === 'object' && typeof up.command === 'string') {
      return up.command.trim() || null;
    }
  } catch {}
  return null;
}

function printDefault(parsed) {
  let line = 'Claude Code';
  try {
    const model = parsed && parsed.model && (parsed.model.display_name || parsed.model.id);
    const dir =
      parsed &&
      ((parsed.workspace && parsed.workspace.current_dir) || parsed.cwd);
    const parts = [];
    if (model) parts.push(String(model));
    if (dir) parts.push(path.basename(String(dir)));
    if (parts.length) line = parts.join(' -- ');
  } catch {}
  try { process.stdout.write(line + '\n'); } catch {}
}

// ─── (2) Self-gating context report ──────────────────────────────────────────
function maybeReportContext(parsed) {
  const pct = extractPct(parsed);
  if (pct == null) return; // nothing meaningful to report

  const marker = readFreshMarker();
  if (!marker) return; // not connected / stale -> self-no-op

  postContext(marker, pct);
}

function extractPct(parsed) {
  const rp =
    parsed &&
    parsed.context_window &&
    parsed.context_window.remaining_percentage;
  const n = Number(rp);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function readFreshMarker() {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
  } catch {
    return null; // missing or unparseable
  }
  if (!marker || !marker.session_token || !marker.token || !marker.api_base_url) {
    return null;
  }
  const ts = Date.parse(marker.updated_at);
  if (!Number.isFinite(ts) || Date.now() - ts > MARKER_MAX_AGE_MS) {
    return null; // stale -> the session is (probably) gone; do not report
  }
  return marker;
}

function postContext(marker, pct) {
  const body = JSON.stringify({ session_token: marker.session_token, pct });
  let url;
  try {
    url = new URL('/api/sessions/context', marker.api_base_url);
  } catch {
    return;
  }
  const mod = url.protocol === 'https:' ? require('https') : require('http');

  const req = mod.request(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${marker.token}`,
      },
      timeout: POST_TIMEOUT_MS,
    },
    (res) => { res.resume(); } // drain and discard
  );

  // Unref the socket so this in-flight request NEVER keeps the process alive:
  // the passthrough output is what matters, and it must not be delayed.
  req.on('socket', (s) => { try { s.unref(); } catch {} });
  req.on('error', () => {});
  req.on('timeout', () => { try { req.destroy(); } catch {} });
  try {
    req.write(body);
    req.end();
  } catch {
    // swallow -- fire-and-forget
  }
}
