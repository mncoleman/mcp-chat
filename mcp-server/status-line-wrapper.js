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
 *      in your channel can see it. The marker is keyed by the PROJECT
 *      DIRECTORY: it is resolved from the status-line stdin
 *      `workspace.project_dir` (the connector writes
 *      ~/.mcp-chat/active-session-<sha1(project_dir)[:16]>.json, stamped with
 *      that project_dir). The project dir is stable across a session resume,
 *      whereas the Claude session id is not -- which is why keying by session id
 *      silently failed for resumed sessions. Resolution is robust: it matches on
 *      the stamped project_dir, enumerates all markers as a fallback, and falls
 *      back to a lone fresh marker or the legacy shared
 *      ~/.mcp-chat/active-session.json. The POST never blocks or delays (1) and
 *      swallows every error. When no matching fresh marker exists (>15 min old,
 *      i.e. you are not currently connected to mcp-chat), it does nothing.
 *      Residual caveat: two concurrent channel sessions in the SAME project dir
 *      share one marker (last writer wins) -- a narrow, acceptable case.
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
const crypto = require('crypto');
const { spawn } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.mcp-chat');
const LEGACY_MARKER_FILE = path.join(CONFIG_DIR, 'active-session.json');
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

  const marker = readFreshMarker(parsed);
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

// A marker is usable only if it carries the auth fields AND is fresh (<15 min).
function isFreshValid(marker) {
  if (!marker || !marker.session_token || !marker.token || !marker.api_base_url) {
    return false;
  }
  const ts = Date.parse(marker.updated_at);
  return Number.isFinite(ts) && Date.now() - ts <= MARKER_MAX_AGE_MS;
}

// Read + parse a marker JSON file; never throws (returns null on any error).
function readMarkerFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readFreshMarker(parsed) {
  // Resolve THIS session's marker by PROJECT DIRECTORY: the connector writes
  // active-session-<sha1(project_dir)[:16]>.json stamped with its project_dir.
  // The project dir is stable across a session resume, whereas the Claude
  // session id is not -- so we match on the project dir, not the session id.
  const pd = parsed && ((parsed.workspace && parsed.workspace.project_dir) ||
    (parsed.workspace && parsed.workspace.current_dir) || parsed.cwd);
  const projectDir = pd ? path.resolve(String(pd)) : null;

  // (a) Direct hit: the marker keyed by this project dir's hash, if its stamped
  //     project_dir matches exactly.
  if (projectDir) {
    let projectKey = null;
    try {
      projectKey = crypto.createHash('sha1').update(projectDir).digest('hex').slice(0, 16);
    } catch {}
    if (projectKey) {
      const marker = readMarkerFile(path.join(CONFIG_DIR, `active-session-${projectKey}.json`));
      if (marker && isFreshValid(marker) && markerProjectDir(marker) === projectDir) {
        return marker;
      }
    }
  }

  // Enumerate all active-session-*.json markers once for the fallbacks below.
  let names = [];
  try {
    names = fs.readdirSync(CONFIG_DIR).filter((n) => /^active-session-.*\.json$/.test(n));
  } catch {
    names = [];
  }

  // (b) Robust fallback: among fresh+valid markers, return the FIRST whose
  //     stamped project_dir matches this session's project dir. Covers a hash
  //     mismatch (e.g. path-normalisation differences on either side).
  if (projectDir) {
    for (const name of names) {
      const marker = readMarkerFile(path.join(CONFIG_DIR, name));
      if (marker && isFreshValid(marker) && markerProjectDir(marker) === projectDir) {
        return marker;
      }
    }
  }

  // (c) Single-session fallback: if the project dir gave no match, collect ALL
  //     fresh+valid markers; if EXACTLY ONE exists AND it carries no project_dir
  //     stamp, use it (covers a pre-1.8.0 marker in a genuine single-session
  //     setup). A stamped-but-non-matching marker belongs to a DIFFERENT project
  //     and must never be posted to -- that would mis-attribute this session's %
  //     to another session's badge.
  const fresh = [];
  for (const name of names) {
    const marker = readMarkerFile(path.join(CONFIG_DIR, name));
    if (marker && isFreshValid(marker)) fresh.push(marker);
  }
  if (fresh.length === 1 && markerProjectDir(fresh[0]) === null) return fresh[0];

  // (d) Legacy fallback: the pre-per-session shared marker.
  const legacy = readMarkerFile(LEGACY_MARKER_FILE);
  if (legacy && isFreshValid(legacy)) return legacy;

  // (e) Nothing usable.
  return null;
}

// Normalise a marker's stamped project_dir for comparison; null if absent/bad.
function markerProjectDir(marker) {
  try {
    if (marker && typeof marker.project_dir === 'string') {
      return path.resolve(marker.project_dir);
    }
  } catch {}
  return null;
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
