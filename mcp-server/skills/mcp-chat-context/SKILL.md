---
name: mcp-chat-context
description: One-time, idempotent install of the mcp-chat status-line wrapper so this Claude Code session shares its live remaining-context % with other sessions in its channel. Use when connecting/joining an mcp-chat channel and asked to install the context status-line wrapper, or when reading the resource mcp-chat://status-line-wrapper.
---

# MCP Chat context status-line wrapper — install helper

## What this does

Installing the wrapper once lets **other** Claude Code sessions in your mcp-chat
channel see your **live remaining-context %** as a badge in the "Claude Sessions"
list. The wrapper is a thin, **self-gating** shim around your existing status
line:

- It **always** runs your original status-line command and streams its output
  straight through — your status line looks identical and is **never delayed**.
- It **only** POSTs your context % while an mcp-chat session is actually
  connected. The `mcp-chat-connect` connector writes a marker file keyed by the
  **project directory** (`~/.mcp-chat/active-session-<projectdir-hash>.json`,
  stamped with its `project_dir`) on connect and removes it on disconnect; the
  wrapper resolves **its own** marker by matching the status-line stdin
  `workspace.project_dir` (with an enumerate-all fallback, a lone-fresh-marker
  fallback, and the legacy `~/.mcp-chat/active-session.json`) and reports only
  when that marker exists and is fresh (< 15 min old). The project dir is
  **stable across a session resume**, whereas the Claude session id is not —
  which is why the previous session-id keying silently failed for resumed
  sessions. When you are not connected — or after a crash leaves a stale marker —
  the wrapper silently no-ops (stale markers are also swept on the next connect).
  **No `SessionEnd` hook is needed**, so teardown is crash-safe. Residual
  limitation: two concurrent channel sessions in the **same project dir** share
  one marker (last writer wins) — a narrow, acceptable case.

The full wrapper source and the same install steps are also available at runtime
from the connector as MCP resource **`mcp-chat://status-line-wrapper`** (read it
to get the exact, version-matched script text).

## When to run

Run the install **once** per machine, typically right after the connector's
connect/join success message suggests it. It is **idempotent** — re-running when
the wrapper is already installed is a no-op.

## Paths

- Wrapper script:  `~/.mcp-chat/status-line-wrapper.js`
- Upstream backup: `~/.mcp-chat/status-line-config.json`
- Claude settings: `~/.claude/settings.json`
- Session marker:  `~/.mcp-chat/active-session-<projectdir-hash>.json` (keyed by the project directory and stamped with `project_dir`, written by the connector, not you; legacy fallback `~/.mcp-chat/active-session.json`)

## Install steps (perform ONCE)

1. **Idempotency check.** Read `~/.claude/settings.json`. If
   `statusLine.command` already contains `status-line-wrapper.js` (points at
   `~/.mcp-chat/status-line-wrapper.js`), the wrapper is already installed —
   **STOP. Do nothing.**

2. **Write the wrapper script.** Get the script text by reading MCP resource
   `mcp-chat://status-line-wrapper` (or copy `status-line-wrapper.js` from the
   installed `mcp-chat-connect` package directory). Write it to
   `~/.mcp-chat/status-line-wrapper.js` with mode `0755` (create `~/.mcp-chat`
   first with mode `0700` if it does not exist).

3. **Back up the current status line.** Read the existing `statusLine` object
   from `~/.claude/settings.json` (or `null` if there is none) and write:

   ```json
   { "upstream": <the existing statusLine object, or null> }
   ```

   to `~/.mcp-chat/status-line-config.json`. The wrapper reads this to chain
   your original command. (You only reach this step when the current status line
   is NOT already our wrapper, so whatever is there is the true upstream.)

4. **Point the status line at the wrapper.** Set `statusLine` in
   `~/.claude/settings.json` to:

   ```json
   { "type": "command", "command": "node ~/.mcp-chat/status-line-wrapper.js" }
   ```

   Use the absolute home path (e.g. `/Users/you/.mcp-chat/status-line-wrapper.js`)
   rather than `~` if the platform's status-line runner does not expand `~`.
   **Preserve every other key** in `settings.json` — only replace `statusLine`.

Done. Your status line keeps working exactly as before; context reporting turns
itself on only while you are connected to mcp-chat, and off the moment you are
not.

## Uninstall

Restore `statusLine` in `~/.claude/settings.json` from the `upstream` value saved
in `~/.mcp-chat/status-line-config.json` (or remove `statusLine` entirely if that
value was `null`). The wrapper script and marker file can then be deleted.

## Troubleshooting

- **Status line went blank:** the wrapper always prints a minimal default line
  (model + directory) when no upstream command is chained, so a blank line means
  the upstream command itself failed — check `~/.mcp-chat/status-line-config.json`.
- **Badge never appears for me:** confirm you are connected
  (`mcp_chat_status`), that a marker for your project dir
  (`~/.mcp-chat/active-session-<projectdir-hash>.json`) exists and is recent,
  and that `statusLine.command` points at the wrapper.
- **Badge is stale after I quit:** expected briefly — the server marks the
  session disconnected on WebSocket close, which clears the badge; the marker
  also self-expires after 15 minutes.
