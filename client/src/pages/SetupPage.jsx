import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Copy, Check, Terminal, Radio, Hash, Package, Zap, MessageSquare, Command, Bot } from 'lucide-react'

function CopyBlock({ label, content }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(content)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = content
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      toast.success(`${label} copied`)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed -- select and copy manually')
    }
  }

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
        <Button variant="ghost" size="sm" onClick={handleCopy} className="h-7 gap-1">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="bg-muted rounded-lg p-4 text-sm overflow-x-auto whitespace-pre-wrap break-all font-mono">
        {content}
      </pre>
    </div>
  )
}

export default function SetupPage() {
  const baseUrl = window.location.origin

  const agentPrompt = `Set up MCP Chat for my Claude Code environment. Run these commands:

1. Install the MCP server globally:
npm install -g mcp-chat-connect

2. Register it with Claude Code:
claude mcp add -e MCP_CHAT_URL=${baseUrl} -s user mcp-chat $(which mcp-chat-connect)

3. Add this shell alias to my ~/.zshrc (or ~/.bashrc):
echo '' >> ~/.zshrc
echo '# MCP Chat - Claude Code with channels' >> ~/.zshrc
echo "alias claudechat='claude --dangerously-load-development-channels server:mcp-chat --dangerously-skip-permissions'" >> ~/.zshrc

4. Verify the server is connected:
claude mcp get mcp-chat

After setup, tell me to run "source ~/.zshrc" and then I can start a session with "claudechat".`

  const shellAlias = `# Add to your ~/.zshrc or ~/.bashrc
alias claudechat='claude --dangerously-load-development-channels server:mcp-chat --dangerously-skip-permissions'`

  const launchCommand = 'claude --dangerously-load-development-channels server:mcp-chat --dangerously-skip-permissions'

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8 overflow-y-auto h-full">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Setup</h1>
        <p className="text-muted-foreground">Connect your Claude Code sessions to MCP Chat with live notifications</p>
      </div>

      {/* Quick setup - AI agent prompt */}
      <div className="space-y-4 border rounded-lg p-6 bg-primary/5">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Quick Setup</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Paste this prompt into any Claude Code session and it will set everything up for you automatically.
        </p>
        <CopyBlock label="Paste this into Claude Code" content={agentPrompt} />
      </div>

      <Separator />

      {/* Manual setup */}
      <div>
        <h2 className="text-lg font-semibold mb-1">Manual Setup</h2>
        <p className="text-sm text-muted-foreground">If you prefer to do it step by step.</p>
      </div>

      {/* Step 1: Install */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">1</Badge>
          <h2 className="text-lg font-semibold">Install the MCP Server</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Install the package globally so Claude Code can find it instantly (no download delay).
        </p>
        <CopyBlock label="Install globally" content="npm install -g mcp-chat-connect" />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Package className="h-3 w-3" />
          <span>Package: <a href="https://www.npmjs.com/package/mcp-chat-connect" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">mcp-chat-connect</a> on npm</span>
        </div>
      </div>

      {/* Step 2: Register with Claude Code */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">2</Badge>
          <h2 className="text-lg font-semibold">Register with Claude Code</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Add the MCP server to your Claude Code user config so it's available in every session.
        </p>
        <CopyBlock label="Register MCP server" content={`claude mcp add -e MCP_CHAT_URL=${baseUrl} -s user mcp-chat $(which mcp-chat-connect)`} />
        <p className="text-sm text-muted-foreground">
          Verify it's connected:
        </p>
        <CopyBlock label="Verify" content="claude mcp get mcp-chat" />
      </div>

      {/* Step 3: Shell alias */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">3</Badge>
          <h2 className="text-lg font-semibold">Create a Shell Shortcut</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Add an alias so you can type <code className="bg-muted px-1 rounded">claudechat</code> to start a session with channels enabled.
        </p>
        <CopyBlock label="Add to ~/.zshrc or ~/.bashrc" content={shellAlias} />
        <p className="text-sm text-muted-foreground">
          Then run <code className="bg-muted px-1 rounded">source ~/.zshrc</code> or restart your terminal.
        </p>
      </div>

      {/* Step 4: Launch and connect */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">4</Badge>
          <h2 className="text-lg font-semibold">Launch and Connect</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Start a session and tell Claude to connect:
        </p>
        <CopyBlock label="Launch" content="claudechat" />
        <CopyBlock label="Then say" content="Connect to MCP Chat" />
        <p className="text-sm text-muted-foreground">
          Your browser opens automatically. Sign in with Google, pick a channel, and your session is live.
          Messages from other team members will appear in your conversation in real-time.
        </p>
        <p className="text-sm text-muted-foreground">
          To resume a previous session with channels: <code className="bg-muted px-1 rounded">claudechat --resume</code>
        </p>
      </div>

      <Separator />

      {/* Research preview note */}
      <div className="border rounded-lg p-4 bg-amber-50 border-amber-200 space-y-2">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-600" />
          <span className="text-sm font-medium text-amber-900">Channels is a Research Preview</span>
        </div>
        <p className="text-xs text-amber-800">
          The <code className="bg-amber-100 px-1 rounded">--dangerously-load-development-channels</code> flag
          does two things: it enables the channels listener (like <code className="bg-amber-100 px-1 rounded">--channels</code>)
          and allows loading custom channel servers. The <code className="bg-amber-100 px-1 rounded">--channels</code> flag
          alone only works with Anthropic-maintained plugins (Telegram, Discord). Since MCP Chat is a custom server,
          it needs the development variant. The <code className="bg-amber-100 px-1 rounded">dangerously</code> prefix
          is standard Anthropic convention for user-controlled extensions during the research preview -- it will simplify
          as channels reaches general availability.
        </p>
      </div>

      <Separator />

      {/* Available tools */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Available Tools</h2>
        <p className="text-sm text-muted-foreground">Once connected, Claude has access to these tools:</p>
        <div className="border rounded-lg divide-y">
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_connect</code>
            <span className="text-sm text-muted-foreground">Opens browser to authenticate and select a channel. Starts the live message stream.</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_send</code>
            <span className="text-sm text-muted-foreground">Send a message to your connected channel</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_read</code>
            <span className="text-sm text-muted-foreground">Read recent message history from your channel</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_presence</code>
            <span className="text-sm text-muted-foreground">See who is online and active sessions in your channel</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_status</code>
            <span className="text-sm text-muted-foreground">Check your connection status and WebSocket health</span>
          </div>
        </div>
      </div>

      <Separator />

      {/* How it works */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Terminal className="h-5 w-5 text-primary" />
              <h3 className="font-medium text-sm">Sending</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Tell Claude to send a message. It calls <code className="bg-muted px-1 rounded">mcp_chat_send</code> which
              posts to the channel via the API. The message appears in the web UI and is pushed to other connected sessions.
            </p>
          </div>
          <div className="border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-primary" />
              <h3 className="font-medium text-sm">Receiving</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              When someone else sends a message to your channel, the MCP server receives it via WebSocket and pushes it
              into your Claude session as a <code className="bg-muted px-1 rounded">&lt;channel&gt;</code> notification.
              Claude sees it immediately.
            </p>
          </div>
          <div className="border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Radio className="h-5 w-5 text-primary" />
              <h3 className="font-medium text-sm">Web UI</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              All messages are visible in the web chat at <code className="bg-muted px-1 rounded">{window.location.host}</code>.
              You can read and send messages from the browser too -- it's a full chat interface.
            </p>
          </div>
          <div className="border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Hash className="h-5 w-5 text-primary" />
              <h3 className="font-medium text-sm">Per-Session Channels</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Each Claude Code session connects to one channel at a time. Different sessions can be on different channels.
              Run <code className="bg-muted px-1 rounded">mcp_chat_connect</code> again to switch channels.
            </p>
          </div>
        </div>
      </div>

      <Separator />

      {/* FAQ */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">FAQ</h2>
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Do I need the special flag every time?</p>
            <p className="text-sm text-muted-foreground">
              Yes, for live message receiving. The <code className="bg-muted px-1 rounded">--dangerously-load-development-channels</code> flag
              enables both channels and custom server loading in one flag. Without it,
              you can still use the tools to send and read messages manually, but you won't get real-time push.
              Use the shell alias (<code className="bg-muted px-1 rounded">claudechat</code>) to avoid typing it every time.
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">Can I resume a session with channels?</p>
            <p className="text-sm text-muted-foreground">
              Yes. Use <code className="bg-muted px-1 rounded">claudechat --resume</code> to pick up where you left off
              with channels re-enabled. You can also pass a specific session ID.
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">Can I connect an already-running session?</p>
            <p className="text-sm text-muted-foreground">
              You can use <code className="bg-muted px-1 rounded">mcp_chat_connect</code> to authenticate and send/read
              messages from any session. However, live push notifications only work when the session was started with the channels flag.
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">What happens if my WebSocket disconnects?</p>
            <p className="text-sm text-muted-foreground">
              The MCP server automatically reconnects every 5 seconds. Use <code className="bg-muted px-1 rounded">mcp_chat_status</code> to
              check the connection health.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
