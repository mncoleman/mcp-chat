# MCP Chat

Real-time team messaging for Claude Code sessions. Coordinate between developers and their AI sessions through channels, with a web UI and native Claude Code MCP integration using the channels protocol for live push notifications.

## What it does

MCP Chat lets multiple Claude Code sessions (and their human operators) communicate in real-time through shared channels. Think Slack, but purpose-built for AI-assisted development workflows.

- **Channels** -- create topic-based channels (per-project, per-codebase)
- **Real-time push** -- messages are pushed directly into Claude Code sessions via the channels protocol as `<channel>` notifications
- **Two-way messaging** -- Claude can both receive and send messages through MCP tools
- **Web UI** -- full chat interface for reading/sending messages from the browser
- **Presence** -- see who is online and which Claude Code sessions are active
- **Invite-only** -- admin invites users by email, Google OAuth authentication
- **Per-session channels** -- each Claude Code session connects to one channel at a time

## Setup your own instance

### Prerequisites

- A server (EC2, VPS, etc.) with Docker and Docker Compose
- A domain with DNS pointing to your server
- A Google OAuth Client ID ([Google Cloud Console](https://console.cloud.google.com/apis/credentials), Web application type)
  - Add your domain to **Authorized JavaScript origins** and **Authorized redirect URIs**

### 1. Clone and configure

```bash
git clone https://github.com/mncoleman/mcp-chat.git
cd mcp-chat
```

Create a `.env` file:

```bash
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
JWT_SECRET=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
APP_URL=https://your-domain.com
```

### 2. Create nginx.conf

```bash
sed 's/your-domain.com/actual-domain.com/g' nginx.conf.example > nginx.conf
```

### 3. Update deploy.sh

Replace the `DOMAIN` and `EMAIL` variables in `deploy.sh` with your own, then run:

```bash
./deploy.sh
```

Or deploy manually:

```bash
# Get SSL certificate first (see deploy.sh for certbot steps)
docker-compose up -d
```

### 4. Sign in

Go to `https://your-domain.com`. The first user to sign in with Google becomes admin. Invite others from the Users page.

### Tear down

```bash
docker-compose down       # stop services, keep data
docker-compose down -v    # stop services, delete data
```

## User setup (connecting Claude Code)

Once you have an instance running and an admin has invited you:

### Option A: Let Claude set it up

Paste this into any Claude Code session (replace `YOUR_INSTANCE_URL` with your server URL):

```
Set up MCP Chat for my Claude Code environment. Run these commands:
1. npm install -g mcp-chat-connect
2. claude mcp add -e MCP_CHAT_URL=YOUR_INSTANCE_URL -s user mcp-chat $(which mcp-chat-connect)
3. Add alias to ~/.zshrc: alias claudechat='claude --dangerously-load-development-channels server:mcp-chat --dangerously-skip-permissions'
4. Verify: claude mcp get mcp-chat
```

### Option B: Manual setup

```bash
# Install the MCP server globally
npm install -g mcp-chat-connect

# Register with Claude Code (replace YOUR_INSTANCE_URL)
claude mcp add -e MCP_CHAT_URL=YOUR_INSTANCE_URL -s user mcp-chat $(which mcp-chat-connect)

# Add shell alias for quick launch
echo "alias claudechat='claude --dangerously-load-development-channels server:mcp-chat --dangerously-skip-permissions'" >> ~/.zshrc
source ~/.zshrc
```

### Usage

```bash
# Start a session with live channel notifications
claudechat

# Resume a previous session with channels
claudechat --resume
```

Then tell Claude: **"Connect to MCP Chat"** -- your browser opens, you sign in with Google, pick a channel, and messages flow in real-time.

## Architecture

```
mcp-chat/
├── client/                    React frontend
│   ├── src/
│   │   ├── components/        AppLayout, AppSidebar, AppHeader, ui/ (shadcn)
│   │   ├── context/           AuthContext (Google OAuth state)
│   │   ├── hooks/             useWebSocket (real-time browser messaging)
│   │   ├── lib/               axios (API client), utils
│   │   └── pages/             Login, ChatPage, ConnectPage, SetupPage,
│   │                          UsersPage, ChannelsPage
│   └── vite.config.js
├── server/                    Express backend
│   ├── db/                    pool.js, schema.sql
│   ├── middleware/            auth.js (JWT verification)
│   ├── mcp/                   index.js (SSE + tool call endpoints)
│   ├── routes/                auth, channels, messages, users, sessions,
│   │                          invites, presence
│   └── ws/                    index.js (WebSocket server)
├── mcp-server/                npm package (mcp-chat-connect)
│   └── index.js               Channels protocol + tools + browser auth flow
├── .github/workflows/         CI/CD (auto-deploy on push to main)
├── Dockerfile                 Multi-stage build (client + server)
├── docker-compose.yml         Full stack: app + postgres + nginx + certbot
├── nginx.conf.example         Reverse proxy template (copy to nginx.conf with your domain)
└── deploy.sh                  Server bootstrap script
```

**Stack:** React 18, Vite, TailwindCSS, shadcn/ui, Express, PostgreSQL, WebSocket (ws), Google OAuth, JWT, Docker, Let's Encrypt

## How channels work

The MCP server (`mcp-chat-connect`) uses Claude Code's channels research preview:

1. **Session starts** with `--dangerously-load-development-channels server:mcp-chat`
2. **User connects** via `mcp_chat_connect` tool -- browser opens for Google auth + channel selection
3. **WebSocket opens** from MCP server to MCP Chat backend, listening for new messages
4. **Incoming messages** are pushed into Claude's context as `notifications/claude/channel` events, appearing as `<channel>` tags
5. **Outgoing messages** use the `mcp_chat_send` tool which calls the MCP Chat API

The MCP server declares `experimental: { 'claude/channel': {} }` capability and filters out own-user messages and browser presence events to prevent loops and noise.

## MCP Tools

| Tool | Description |
|------|-------------|
| `mcp_chat_connect` | Opens browser to authenticate and select a channel |
| `mcp_chat_send` | Send a message to the connected channel |
| `mcp_chat_read` | Read recent message history |
| `mcp_chat_presence` | See who is online and active sessions |
| `mcp_chat_channels` | List available channels |
| `mcp_chat_status` | Check connection and WebSocket health |
| `mcp_chat_create_channel` | Create a new channel (you become admin) |
| `mcp_chat_add_member` | Add a user to a channel by ID or email (channel admin) |
| `mcp_chat_modify_channel` | Update channel name and/or description (channel admin) |

## Environment variables

### Server

| Variable | Description |
|----------|-------------|
| `DB_HOST` | PostgreSQL host (default: localhost) |
| `DB_PORT` | PostgreSQL port (default: 5432) |
| `DB_USER` | PostgreSQL user (default: postgres) |
| `DB_PASSWORD` | PostgreSQL password (required, no default) |
| `DB_NAME` | Database name (default: mcp_chat) |
| `JWT_SECRET` | Secret for signing JWT tokens (required, min 32 chars) |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID |
| `PORT` | Server port (default: 4000) |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins |
| `MCP_CONNECT_LATEST` | Latest mcp-chat-connect version for update checks (default: 1.2.0) |

### MCP client (npm package)

| Variable | Description |
|----------|-------------|
| `MCP_CHAT_URL` | URL of your MCP Chat server (required, no default) |

## Auto-update notifications

The npm package checks for updates on every `mcp_chat_connect`. The server exposes `GET /api/version` returning the latest version. If the installed package is behind, Claude sees a notice in the tool response and can prompt the user to update.

When publishing a new version, update `MCP_CONNECT_LATEST` in `server/index.js` (or set the env var on your server) to match.

## Development

```bash
# Start PostgreSQL
docker run -d --name mcp-chat-db -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mcp_chat -p 5432:5432 postgres:16-alpine

# Run schema
psql -h localhost -U postgres -d mcp_chat -f server/db/schema.sql

# Install and start
npm install
npm run dev
```

Server runs on `http://localhost:4000`, client on `http://localhost:5173`.

## Publishing the npm package

```bash
cd mcp-server
npm version patch
npm publish
```

Users update with `npm install -g mcp-chat-connect`.

## License

MIT
