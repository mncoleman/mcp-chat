# MCP Chat

## Architecture

Monorepo with three components:

- **client/** -- React 18 + Vite + TailwindCSS + shadcn/ui. Module pattern: pages in `src/pages/`, shared components in `src/components/`, auth context in `src/context/AuthContext.jsx`.
- **server/** -- Express on Node.js. Raw SQL via `pg` pool (no ORM). JWT auth middleware at `server/middleware/auth.js`. Routes in `server/routes/`. WebSocket server at `server/ws/index.js`. MCP SSE/HTTP endpoint at `server/mcp/index.js`.
- **mcp-server/** -- Standalone MCP server published as `mcp-chat-connect` on npm. JSON-RPC over stdio. Opens browser for OAuth flow, stores token at `~/.mcp-chat/config.json`.

## Database

PostgreSQL with tables: `users`, `channels`, `channel_members`, `messages`, `sessions`, `invites`. Schema at `server/db/schema.sql`. Connection pool at `server/db/pool.js`.

## Auth flow

Google OAuth via `@react-oauth/google` on frontend. Server verifies ID token with `google-auth-library`. First user auto-becomes admin. All others require email invite (admin creates invite with email, person must sign in with matching Google account).

## Key patterns

- Routes use raw parameterized SQL queries (no ORM)
- WebSocket at `/ws` for real-time browser messaging
- MCP endpoint at `/mcp/call` for Claude Code tool calls, `/mcp/sse` for server push
- Static client served by Express in production (built client at `client/dist/`)
- SPA fallback middleware serves `index.html` for non-API routes
- Helmet with relaxed COOP/COEP/CSP for Google OAuth compatibility

## Deployment

Docker Compose on AWS EC2: app (Node + built client), postgres, nginx (SSL termination), certbot (Let's Encrypt auto-renewal).

- **Instance:** i-0d05b0b7a28157174 in us-east-1
- **Domain:** mcpchat.dovito.com -> 34.207.234.217
- **Security group:** sg-012677476034006d1 (ports 22, 80, 443)
- **SSH key:** mcp-chat-key (uses ~/.ssh/id_ed25519)
- **Deploy path on EC2:** /home/ec2-user/mcp-chat

### Deploy commands

```bash
# Upload and rebuild
rsync -avz --exclude node_modules --exclude .git --exclude certbot . ec2-user@34.207.234.217:/home/ec2-user/mcp-chat/
ssh ec2-user@34.207.234.217 "cd /home/ec2-user/mcp-chat && source .env && sudo docker build --no-cache --build-arg VITE_GOOGLE_CLIENT_ID=\$GOOGLE_CLIENT_ID --build-arg VITE_API_URL=\$APP_URL -t mcp-chat-app . && sudo /usr/local/bin/docker-compose up -d app"
```

### Tear down

```bash
# Stop services
ssh ec2-user@34.207.234.217 "cd /home/ec2-user/mcp-chat && sudo /usr/local/bin/docker-compose down"

# Terminate EC2 instance entirely
aws ec2 terminate-instances --instance-ids i-0d05b0b7a28157174 --region us-east-1

# Clean up AWS resources
aws ec2 delete-security-group --group-id sg-012677476034006d1 --region us-east-1
aws ec2 delete-key-pair --key-name mcp-chat-key --region us-east-1

# Remove DNS A record for mcpchat.dovito.com
```

### npm package

Published as `mcp-chat-connect` on npm under `mncoleman`. To publish updates:
```bash
cd mcp-server && npm version patch && npm publish
```

## Rules

- No emojis in code, comments, or UI text
- Helmet CSP/COOP/COEP must remain disabled for Google OAuth to work
- Config file at ~/.mcp-chat/config.json must have 0o600 permissions
- All user input in HTML responses must be escaped with escapeHtml()
- SQL queries must use parameterized queries ($1, $2, etc.) -- never string interpolation
