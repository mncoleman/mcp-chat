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

## Channels protocol

The MCP server (`mcp-server/index.js`) integrates with Claude Code's channels research preview:
- Declares `experimental: { 'claude/channel': {} }` in initialize response
- After `mcp_chat_connect`, opens WebSocket to the MCP Chat backend
- Incoming messages emit `notifications/claude/channel` via stdout as JSON-RPC notifications
- Claude receives them as `<channel source="mcp-chat" ...>` tags
- Filters: own user_id messages excluded (prevents echo loops), browser presence events excluded (reduces noise)
- Session must be started with `--dangerously-load-development-channels server:mcp-chat`

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
Users update with: `npm install -g mcp-chat-connect`

### User setup (on their machine)

```bash
npm install -g mcp-chat-connect
claude mcp add -e MCP_CHAT_URL=https://your-domain.com -s user mcp-chat $(which mcp-chat-connect)
alias claudechat='claude --dangerously-load-development-channels server:mcp-chat --dangerously-skip-permissions'
```

## npm Publishing

The `mcp-chat-connect` package requires 2FA for npm publish. Claude cannot publish directly. After bumping the version, provide the user with the terminal commands to publish:

```bash
cd mcp-server && npm publish
```

## Rules

- No emojis in code, comments, or UI text
- Helmet CSP/COOP/COEP must remain disabled for Google OAuth to work
- Config file at ~/.mcp-chat/config.json must have 0o600 permissions
- All user input in HTML responses must be escaped with escapeHtml()
- SQL queries must use parameterized queries ($1, $2, etc.) -- never string interpolation
- JWT_SECRET must be enforced on startup -- no fallback defaults
- Message content must be validated (length + type) before DB insert
- Own-user messages and browser presence events must be filtered in the MCP server to prevent loops/noise
