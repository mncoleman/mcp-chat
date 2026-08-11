# MCP Chat

## Architecture

Monorepo with three components:

- **client/** -- React 18 + Vite + TailwindCSS + shadcn/ui. Pages in `src/pages/` (Login, ChatPage, ConnectPage, SetupPage, UsersPage, ChannelsPage). Shared components in `src/components/` (AppLayout, AppSidebar, AppHeader, ui/). Auth context in `src/context/AuthContext.jsx`. WebSocket hook in `src/hooks/useWebSocket.js`.
- **server/** -- Express on Node.js. Raw SQL via `pg` pool (no ORM). JWT auth middleware at `server/middleware/auth.js`. Routes in `server/routes/` (auth, channels, messages, users, sessions, invites, presence). WebSocket server at `server/ws/index.js`. MCP SSE/HTTP endpoint at `server/mcp/index.js`.
- **mcp-server/** -- Standalone MCP server published as `mcp-chat-connect` on npm. JSON-RPC over stdio with channels protocol support. Declares `experimental: { 'claude/channel': {} }` capability. Opens browser for OAuth flow, connects WebSocket for live message push, stores token at `~/.mcp-chat/config.json` (0o600 permissions).

## Database

PostgreSQL with tables: `users`, `channels`, `channel_members`, `messages`, `sessions`, `invites`. Schema at `server/db/schema.sql`. Connection pool at `server/db/pool.js`. Cascading deletes on channels (removes members, messages, sessions).

## Auth flow

Google OAuth via `@react-oauth/google` on frontend. Server verifies ID token with `google-auth-library`. First user auto-becomes admin. All others require email invite (admin creates invite with email, person must sign in with matching Google account).

Sign in with Systematics is an optional second provider wired in `server/routes/systematics-auth.js`. The button renders on the login page only when all four `SYSTEMATICS_*` env vars are set. The server runs a standards-compliant authorization-code + PKCE flow against `SYSTEMATICS_ISSUER_URL`, verifies the id_token via JWKS (`jose`), and mirrors the Google flow for first-user/invite rules -- users are matched by email so a single user can sign in with either provider.

## Channels protocol

The MCP server (`mcp-server/index.js`) integrates with Claude Code's channels research preview:
- Declares `experimental: { 'claude/channel': {} }` in initialize response
- After `mcp_chat_connect`, opens WebSocket to the MCP Chat backend
- Incoming messages emit `notifications/claude/channel` via stdout as JSON-RPC notifications
- Claude receives them as `<channel source="mcp-chat" ...>` tags
- Filters: own user_id messages excluded (prevents echo loops), browser presence events excluded (reduces noise)
- Session must be started with `--dangerously-load-development-channels server:mcp-chat`

## Desktop app: watch instead of push

The Claude desktop app spawns Claude Code with its own argv and never passes `--dangerously-load-development-channels`, and no setting adds it. A desktop session can send, read, and join, but nothing is pushed to it while idle. `mcp-chat-connect watch` (subcommand dispatched at the top of `mcp-server/index.js`, implemented in `mcp-server/watch.js`) is the answer: run as a background command, it blocks until the session is mentioned, then exits -- a finished background command is what re-invokes the model, so a quiet channel costs nothing.

- It connects to `/ws` **without** a `session` param, which makes it a browser-class client: it receives every message even in mention mode, triggers no presence broadcast, and writes no session row, so it cannot collide with the label of the session it watches. Mention matching is done locally by `mentions()`, mirroring `resolveMentions`.
- It is keyed on the **session token**, not the label, and follows `session_renamed` for that token. A label is mutable, and a watcher listening for a name its session no longer answers to reports silence forever.
- Silence is never ambiguous: exit 0 = mentioned (message printed as JSON), 2 = usage, 3 = auth rejected/expired, 4 = stale or failed connection, 5 = hit `--timeout`. An expired token returns no messages, which is indistinguishable from a quiet channel unless it exits loudly. A 95s no-traffic watchdog catches a wedged socket (the server pings every 30s).
- `--timeout` parses as a **float** deliberately: `parseInt` would turn `--timeout 0.5` into "never time out", the one behavior a watcher must not do by accident.
- `mcp_chat_status` reports the channel id and session token so a session can arm its own watcher.
- Gap it does not close on its own: a mention landing between one watcher exiting and the next starting is not pushed to it. The server side of durable delivery now covers that -- see "Durable delivery" below -- but the watcher must ask (`get_unseen`) on start; the socket alone will not tell it.

## When delivery stops

A session that is deaf must never look like a session in a quiet channel. Three rules in `mcp-server/index.js` enforce that:

- **A 4001/1008 close is terminal, not a retry.** The token will not become valid, so the client stops reconnecting, sets `sessionState.wsAuthFailed`, and pushes an `auth_failed` channel notification. Before this it retried every 5s forever and said nothing but one stderr line: sends failed loudly, receives failed silently, and the channel looked quiet. `mcp_chat_status` reports the rejection rather than "reconnecting", which reads as temporary.
- **Other drops back off** (5s, 10s, 20s, 40s, capped at 60s) and push one `delivery_degraded` notice at attempt 4, roughly a minute of real downtime, plus a `delivery_restored` notice on recovery -- but only if the session was told it was degraded, so a routine blip stays silent. A reconnect that *succeeds* resets the counter: escalation is for an unreachable server, not for one flaky moment.
- **`normalizeMeta` coerces every notification meta value to a string.** Meta is `Record<string,string>` and a single non-string value makes Claude Code drop the entire notification with no error anywhere -- v1.5.0 shipped a boolean `mentioned` and blackholed every message for every session on that version. Coerce and warn on stderr; never let a type slip cost the message.

Noise follows the same principle in reverse: presence events and channel renames are pushed only in `broadcast` mode. Mentions-only means "do not interrupt me unless I am addressed", and pushing every other member's session connect/disconnect into context was ignoring that. Presence is a pull -- `mcp_chat_presence` answers it on demand.

## Delivery modes

Each channel has a `delivery_mode` (`channels.delivery_mode`, default `broadcast`) controlling **instant push** to Claude sessions only — it never affects access. Any channel member can change it (chat-header toggle, `PUT /api/channels/:id/mode`, the `set_channel_mode` MCP method, or the `mcp_chat_set_mode` tool).

- **`broadcast`** (default): every connected session is pushed every message (legacy behavior).
- **`mention`**: only sessions whose label is `@<session-label>`-mentioned are pushed (the push frame is tagged `mentioned:true`). Un-mentioned sessions get nothing pushed but can still `mcp_chat_read` the full history — messages are not private, only delivery is gated. Mentioning a *human member* does not push to any session.

**Browsers always receive every message** in both modes (mention-gating is for session push, not the human UI). All delivery flows through one choke point, `deliverMessage(channelId, message)` in `server/ws/index.js`, which the three send paths (browser WS, `POST /messages`, MCP `send_message`) call. Mention parsing lives in `resolveMentions(channelId, content)` (same file) and mirrors the client's `splitMentions` matching in `client/src/pages/ChatPage.jsx` (word-boundary `@`, longest label first, case-insensitive, char after label not `\w`); it draws from **all** sessions ever in the channel, not just connected ones. The `channel_mode_updated` WS event keeps browsers and sessions in sync on change.

## Durable delivery (missed-message replay)

Delivery used to touch only currently-open sockets, so a message sent during a reconnect window was lost to that session and an `@mention` of a session with no socket open was dropped entirely. Messages were never lost (they are written to `messages` before delivery is attempted) -- what was missing was any way for a session to learn it missed something. `server/lib/replay.js` closes that on the server side.

- **No schema change.** The cursor is derived, not stored: `messages.id` is SERIAL so `m.id > anchor` is the replay predicate, and the anchor comes from the newest of `sessions.created_at / connected_at / disconnected_at`, converted to an id with `SELECT COALESCE(MAX(id),0) ... WHERE created_at <= anchor_time`. Timestamps only *derive* the starting id; they are never compared message-to-message.
- **Read the session row BEFORE writing it.** Both the WS connect path and MCP `register_session` stamp `connected_at = NOW()`. Deriving the anchor after that write moves it to this instant and every gap looks empty. `server/ws/index.js` captures `priorSession` in the same `SELECT` that already checked token ownership. A client that re-registers should pass its own `since_id`, which always wins over the derived anchor.
- **Replay is OPT-IN on the socket.** The client must send `since=<id>` or `replay=1` on the `/ws` URL; without it the server behaves exactly as it did before. Replayed messages arrive as ordinary `new_message` frames (tagged `replay: true`), and no client published up to 1.10.0 dedupes by id -- an unconditional replay would push up to 50 old messages into context on every reconnect, including the one each deploy causes. The opt-in is what lets the server half ship before the client half.
- **No server-side ack.** Nothing advances a stored cursor because there is no stored cursor. Repeated `get_unseen` calls return the same set until the caller persists the returned `cursor` and passes it back as `since_id`.
- **Bounds:** 50 messages (matches the REST history default in `server/routes/messages.js`) and 24 hours. `truncated_by` is `'count' | 'age' | null` so a caller can tell which bound bit and whether paging forward is worthwhile. In mention mode the *scan* widens to 500 (`REPLAY_MENTION_SCAN_MAX`) before filtering, because a single mention sitting behind 50 unrelated messages is exactly the case this exists to catch; the delivered set is still capped at 50.
- **One gate, not two delivery paths.** `deliverMessage` remains the only live fan-out. What replay shares with it is the *decision*: `isDeliverable(mode, mentionedTokens, sessionToken)` in `server/lib/mentions.js`, which both call, so a session sees on replay exactly what it would have seen live. Mention parsing moved to that module too, split into `loadChannelLabels` (one query per batch, not per message) + the pure `matchMentions`; `resolveMentions(channelId, content)` is still exported from `server/ws/index.js` with its original signature.
- **Membership:** replay on the WS path relies on the connect-time gate already passed above it (do not add a redundant check). `get_unseen` copies the `get_messages` gate -- 403, no admin auto-join carve-out -- and additionally requires the session row to belong to the caller and to be registered in that channel.
- **Harness:** `node server/test-replay.js` (`npm run test:replay` in `server/`) -- a fake pg client covering the never-connected session, the reconnect gap, mention filtering per session, the empty gap, the count bound, the age bound, `since_id` override and fallback, and a deep mention beyond the 50-message cap.
- **Not covered:** SSE sessions (`/mcp/sse`) get no replay and cannot -- that path mints a fresh `session_token` per connection, so there is no identity to carry a cursor. `get_unseen` answers only for the channel a session is *joined* to; a channel it merely sent into holds its identity under the satellite token (`<session_token>-ch<id>`), which is what must be queried there.

### Client contract

- On WS connect a session may pass `&since=<message_id>`; omitted, the server derives the anchor.
- After the existing `connected` frame the server sends, only when something was missed and only to session clients (never browsers):
  1. `{ type: 'replay', channel_id, count, from_id, cursor, truncated_by, delivery_mode }`
  2. then `count` ordinary `{ type: 'new_message', message, mentioned, replay: true }` frames, ascending by id.
- Clients must dedupe by `message.id`. A replayed frame is deliberately shaped like a live one so no new handler is needed.
- `get_unseen` (`POST /mcp/call`, args `channel_id`, `session_token`, optional `since_id`) answers "did I miss anything" with no socket open, returning `{ messages, count, delivery_mode, from_id, anchor_source, cursor, truncated_by }`.

## Private channels

`channels.is_private` (default `false`) controls **access and visibility**, distinct from `delivery_mode` (which only gates push). A private channel is invite-only: it is hidden from and inaccessible to non-members, **including admins** — the legacy "admins see all + auto-join any channel they touch" superpower applies to public channels only.

- **List** (`GET /api/channels`): admins see all public channels plus private channels they belong to; regular users see only their own channels (unchanged). The MCP `list_channels` is already member-only (JOIN `channel_members`).
- **Access/auto-join** is gated in every entry point the same way — auto-join happens only when `req.user.role === 'admin' && !channel.is_private`, else 403/404 for non-members. Sites: REST `GET /:id`, `PUT /:id/instructions`, `PUT /:id/mode`, `messages` GET+POST; `server/ws/index.js` browser WS; `server/mcp/index.js` `/mcp/sse` connect and `register_session`.
- **Set it**: on create (`POST /api/channels` + MCP `create_channel`, `is_private` body/arg) and after (`PUT /api/channels/:id` and MCP `modify_channel`, both channel-admin-or-global-admin gated). `channel_updated` WS event carries `is_private` for live sync.
- **UI**: create forms (ChannelsPage + ConnectPage) offer a Public/Private choice; ChannelsPage expanded panel has a Make private/public toggle (admin); a lock icon marks private channels in the ChannelsPage list, ChatPage sidebar, and ChatPage header.
- **Caveat (god-mode by ID)**: global-admin management-by-ID routes (`DELETE /:id`, `POST/DELETE /:id/members`, all `requireAdmin`) are NOT membership-gated, so a global admin who knows a private channel's ID can still delete it or alter its membership without seeing it. Visibility + all normal access paths are gated; tighten these routes too if privacy from other global admins becomes a requirement.

## Key patterns

- Routes use raw parameterized SQL queries ($1, $2) -- no ORM, no string interpolation
- WebSocket at `/ws` for real-time browser messaging
- MCP endpoint at `/mcp/call` for Claude Code tool calls, `/mcp/sse` for server push
- Static client served by Express in production (built client at `client/dist/`)
- SPA fallback middleware before auth -- serves `index.html` for non-API GET routes
- Helmet with COOP/COEP/CSP disabled for Google OAuth popup compatibility
- CORS restricted to allowed origins (configurable via ALLOWED_ORIGINS env)
- JWT_SECRET enforced on startup (min 32 chars, no fallback)
- Message content validated: max 10K chars, message_type whitelist
- Invite codes use crypto.randomBytes (192-bit entropy)
- Chat UI groups consecutive messages from same user within 2 minutes
- Multi-session: `register_session` assigns sequential labels (Session 1, 2...) per channel. Allocation lives in `server/lib/session-labels.js` and is shared by all three label-writing paths (`register_session`, MCP `rename_session`, `PATCH /api/sessions/:id`) -- patching one and not the others is how a collision comes back. The rule: labels are unique per channel across **all** session rows, connected or not, because a label is the identity stamped on message history and matched by `resolveMentions`. Auto-assignment takes the lowest free N, so N grows monotonically and a number is never reused for a different session. A *requested* label is honored when free and suffixed (`QA Agent (2)`) when taken, so callers must use the label the server returns rather than the one they asked for. Allocation and write run in one transaction under `pg_advisory_xact_lock` on a dedicated client -- a `UNIQUE (channel_id, label)` index is not an option because live data already violates it (legacy duplicates plus the `Claude Code Session` rows the SSE and browser-WS paths insert).
- `mcp_chat_join` connects to a channel by ID without browser auth (uses saved token from prior `mcp_chat_connect`)
- Session naming is bidirectional: a session names itself via `mcp_chat_set_name` (or a `label` arg on `mcp_chat_connect`/`mcp_chat_join`); humans rename any session from the chat Sessions sidebar (`PATCH /api/sessions/:id`). Both broadcast a `session_renamed` WS event -- the renamed session learns its new name via a pushed channel notification, and browsers update the displayed name live.
- A **chosen** name follows the session across channels: `sessionState.labelIsCustom` (client) is set when a `label` arg is passed, `mcp_chat_set_name` succeeds, or a human renames the session from the sidebar, and `mcp_chat_join` then re-requests that name in the channel it joins. An **auto-assigned** `Session N` is deliberately not carried -- it names a slot in the channel that issued it, so carrying it would collide with that channel's own numbering. Without this, one continuous session appeared in history under a different identity in every channel.
- Tool arguments are strict: `handleToolCall` rejects any key a tool's `inputSchema` does not declare, naming the offending key and the accepted ones (and logging to stderr). Silently dropping an undeclared argument is what let `mcp_chat_read` answer about the connected channel when asked for a different one -- a wrong answer indistinguishable from a right one. Any new argument must be added to the schema, not just read in the handler.
- `mcp_chat_read` takes an optional `channel_id` and reads any channel you are a member of **without joining or switching connection**; omitted, it reads the connected channel. `resolveChannel()` resolves the target and errors on an unknown or non-member channel instead of falling back. Membership is enforced server-side by `get_messages` (403, no admin auto-join carve-out) -- the client lookup is for the error message and the channel name, not a security boundary.
- `mcp_chat_presence` takes the same optional `channel_id` and inspects any channel you are a member of without joining. It now returns **members** (everyone in `channel_members`, with channel-admin marked) alongside active sessions -- presence used to answer only "who is connected right now", which is empty for a quiet channel and says nothing about who belongs to it. Membership was already enforced server-side by `get_presence` (403, no admin carve-out), so the client passthrough widens no access.
- `mcp_chat_send` takes the same optional `channel_id` and posts into any channel you are a member of without switching connection. Attribution needs a session row, and `sessions.session_token` is unique so one row cannot span two channels -- so the client registers a **satellite session** in the target under a derived token (`<sessionToken>-ch<id>`) with `connected: false` (new optional arg on `register_session`), which gives the message a label without the session appearing active there. Only a *chosen* name is carried into the satellite; an auto-assigned `Session N` lets the target allocate its own. Satellite identities are cached per channel in `remoteSendSessions` and cleared whenever the session's own identity changes. Sending this way is one-directional: no messages from that channel are pushed back.
  Joining a channel you already sent into passes the satellite's token as `supersede_token` on `register_session`: inside the label lock the server excludes it from the taken-set (so your own name does not suffix itself to `QA Agent (2)`), repoints its messages at the new token, then deletes the row. Without the repoint, deleting the satellite would null out `session_label` on everything it already said. `resolveLabel` therefore takes `excludeTokens` alongside the original single `excludeToken`.
- Participant filter (ChatPage): a channel can be narrowed to one session or one person. People and sessions are **separate axes** -- a person's own messages have `session_id` null while their Claude's messages belong to the session, so filtering to a human must not pull in "their Claude". A session is held by **token**, not label, so a rename keeps the filter pointed at the same session. The list derives everything per message from the FILTERED array: grouping reads the previous *visible* message, or the first message of every run renders with no author header. Filter resets on channel change, during render rather than in an effect, so the next channel never paints empty first.
- Message attribution: every message broadcast/read includes the sender's `session_label` (joined from `sessions`), so the UI and other sessions see exactly which named session sent it. The client resolves names through a map (active sessions + history + live `session_renamed` events) so renames apply retroactively to existing messages.
- Channel instructions: `channels.instructions` is a shared system prompt for a channel. Any member edits it via the chat header panel (`PUT /api/channels/:id/instructions`) or `mcp_chat_set_instructions`/`mcp_chat_instructions`. It is injected into a session's context on connect/join (via `register_session` response) and pushed live on change via the `channel_instructions_updated` WS event.

## Pages

| Route | Page | Access |
|-------|------|--------|
| `/login` | Google OAuth login | Public |
| `/connect` | Channel selection for Claude Code auth flow | Public (with callback param) |
| `/chat` `/chat/:channelId` | Chat interface | Authenticated |
| `/setup` | MCP server setup instructions | Authenticated |
| `/channels` | Channel management (create, delete) | Admin |
| `/users` | User management + email invites | Admin |

## Deployment

Docker Compose: app (Node + built client), postgres, nginx (SSL termination + WebSocket upgrade), certbot (Let's Encrypt auto-renewal).

Configure via `.env`:
```
DB_PASSWORD=your_strong_password
JWT_SECRET=your_random_secret_at_least_32_chars
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
APP_URL=https://your-domain.com
ALLOWED_ORIGINS=https://your-domain.com
```

Update `nginx.conf` with your domain. Run `./deploy.sh` or `docker-compose up -d`.

### CI/CD

Optional GitHub Actions workflow at `.github/workflows/deploy.yml`. Requires GitHub secrets:
- `EC2_HOST` -- server IP
- `EC2_SSH_KEY` -- SSH private key

Push to main -> GitHub Actions SSH into server -> git pull -> docker build with VITE_GOOGLE_CLIENT_ID and VITE_API_URL build args -> docker-compose up -> prune old images.

### npm package

Published as `mcp-chat-connect` on npm. To publish updates:
```bash
cd mcp-server && npm version patch && npm publish
```
Clients registered via `npx -y mcp-chat-connect@latest` (the recommended setup) auto-update on the next session. Anyone who did a global install instead updates with: `npm install -g mcp-chat-connect`

### User setup (on their machine)

```bash
# Registering via `npx -y ...@latest` runs the newest published version every session (no global install, no manual updates, no version drift).
claude mcp add -e MCP_CHAT_URL=https://your-domain.com -s user mcp-chat -- npx -y mcp-chat-connect@latest
alias claudechat='claude --dangerously-load-development-channels server:mcp-chat --dangerously-skip-permissions'
```

## npm Publishing

The `mcp-chat-connect` package requires 2FA for npm publish. Claude cannot publish directly. After bumping the version, provide the user with the terminal commands to publish:

```bash
cd mcp-server && npm publish
```

After every version bump, the `MCP_CONNECT_LATEST` value (what `/api/version` returns for the npm client's update notice) must be updated in **all** of these, since they shadow each other in this order (last wins):

1. `server/index.js` -- code default (`process.env.MCP_CONNECT_LATEST || '1.4.0'`); only used if nothing below is set.
2. `docker-compose.yml` -- compose fallback (`${MCP_CONNECT_LATEST:-1.4.0}`); used on the server when the env var is absent. This was the one that previously drifted and reported a stale version.
3. Server `.env` at `/opt/mcp-chat/.env` -- `MCP_CONNECT_LATEST=...`; overrides everything above. Update it and run `docker compose up -d app` to apply.

Keep all three in sync with the published package version. The `.env` value is authoritative in production; the compose default is the safety net if `.env` is ever missing the line.

## Rules

- No emojis in code, comments, or UI text
- Helmet CSP/COOP/COEP must remain disabled for Google OAuth to work
- Config file at ~/.mcp-chat/config.json must have 0o600 permissions
- All user input in HTML responses must be escaped with escapeHtml()
- SQL queries must use parameterized queries ($1, $2, etc.) -- never string interpolation
- JWT_SECRET must be enforced on startup -- no fallback defaults
- Message content must be validated (length + type) before DB insert
- Own-user messages and browser presence events must be filtered in the MCP server to prevent loops/noise
