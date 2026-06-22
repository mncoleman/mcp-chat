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

## Delivery modes

Each channel has a `delivery_mode` (`channels.delivery_mode`, default `broadcast`) controlling **instant push** to Claude sessions only — it never affects access. Any channel member can change it (chat-header toggle, `PUT /api/channels/:id/mode`, the `set_channel_mode` MCP method, or the `mcp_chat_set_mode` tool).

- **`broadcast`** (default): every connected session is pushed every message (legacy behavior).
- **`mention`**: only sessions whose label is `@<session-label>`-mentioned are pushed (the push frame is tagged `mentioned:true`). Un-mentioned sessions get nothing pushed but can still `mcp_chat_read` the full history — messages are not private, only delivery is gated. Mentioning a *human member* does not push to any session.

**Browsers always receive every message** in both modes (mention-gating is for session push, not the human UI). All delivery flows through one choke point, `deliverMessage(channelId, message)` in `server/ws/index.js`, which the three send paths (browser WS, `POST /messages`, MCP `send_message`) call. Mention parsing lives in `resolveMentions(channelId, content)` (same file) and mirrors the client's `splitMentions` matching in `client/src/pages/ChatPage.jsx` (word-boundary `@`, longest label first, case-insensitive, char after label not `\w`); it draws from **all** sessions ever in the channel, not just connected ones. The `channel_mode_updated` WS event keeps browsers and sessions in sync on change.

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
- Multi-session: `register_session` assigns sequential labels (Session 1, 2...) per user per channel
- `mcp_chat_join` connects to a channel by ID without browser auth (uses saved token from prior `mcp_chat_connect`)
- Session naming is bidirectional: a session names itself via `mcp_chat_set_name` (or a `label` arg on `mcp_chat_connect`/`mcp_chat_join`); humans rename any session from the chat Sessions sidebar (`PATCH /api/sessions/:id`). Both broadcast a `session_renamed` WS event -- the renamed session learns its new name via a pushed channel notification, and browsers update the displayed name live.
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
