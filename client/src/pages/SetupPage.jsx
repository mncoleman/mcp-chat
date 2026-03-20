import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Copy, Check, Terminal, Radio, Hash, Package, Zap, MessageSquare, Command } from 'lucide-react'

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

  const mcpConfig = JSON.stringify({
    "mcpServers": {
      "mcp-chat": {
        "command": "npx",
        "args": ["mcp-chat-connect"],
        "env": {
          "MCP_CHAT_URL": baseUrl
        }
      }
    }
  }, null, 2)

  const shellAlias = `# Add to your ~/.zshrc or ~/.bashrc
alias claudechat='claude --dangerously-load-development-channels server:mcp-chat'`

  const launchCommand = 'claude --dangerously-load-development-channels server:mcp-chat'

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8 overflow-y-auto h-full">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Setup</h1>
        <p className="text-muted-foreground">Connect your Claude Code sessions to MCP Chat with live notifications</p>
      </div>

      {/* Step 1: MCP Config */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">1</Badge>
          <h2 className="text-lg font-semibold">Add MCP Server to Claude Code</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Copy this config and add it to your <code className="bg-muted px-1 rounded">~/.claude/settings.json</code> file.
          No installation or cloning required -- it runs directly from npm via <code className="bg-muted px-1 rounded">npx</code>.
        </p>
        <CopyBlock label="Claude Code MCP Config" content={mcpConfig} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Package className="h-3 w-3" />
          <span>Package: <a href="https://www.npmjs.com/package/mcp-chat-connect" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">mcp-chat-connect</a> on npm</span>
        </div>
      </div>

      {/* Step 2: Launch with channels */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">2</Badge>
          <h2 className="text-lg font-semibold">Start a Session with Channels</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          To receive live messages, start Claude Code with the channels flag. This enables the MCP server to push
          messages directly into your session in real-time.
        </p>
        <CopyBlock label="Launch command" content={launchCommand} />
        <div className="border rounded-lg p-4 bg-amber-50 border-amber-200 space-y-2">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-medium text-amber-900">Channels is a Research Preview</span>
          </div>
          <p className="text-xs text-amber-800">
            The <code className="bg-amber-100 px-1 rounded">--channels</code> flag and the
            <code className="bg-amber-100 px-1 rounded">--dangerously-load-development-channels</code> flag are
            required during the research preview. As Anthropic rolls out channels to general availability,
            this will simplify. The <code className="bg-amber-100 px-1 rounded">dangerously</code> prefix is
            standard for custom (non-Anthropic-maintained) channel servers during the preview period.
          </p>
        </div>
      </div>

      {/* Step 3: Connect to a channel */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">3</Badge>
          <h2 className="text-lg font-semibold">Connect to a Channel</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Once your session is running, tell Claude:
        </p>
        <CopyBlock label="Connect prompt" content="Connect to MCP Chat" />
        <p className="text-sm text-muted-foreground">
          Your browser opens automatically. Sign in with Google, pick a channel, and your session is live.
          Messages from other team members (and their Claude sessions) will appear in your conversation in real-time.
        </p>
      </div>

      <Separator />

      {/* Shell alias tip */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Command className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Tip: Create a Shell Shortcut</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Add an alias to your shell config so you can start a channels-enabled session by typing a single word.
        </p>
        <CopyBlock label="Shell alias (add to ~/.zshrc or ~/.bashrc)" content={shellAlias} />
        <p className="text-sm text-muted-foreground">
          After adding, run <code className="bg-muted px-1 rounded">source ~/.zshrc</code> (or restart your terminal).
          Then just type <code className="bg-muted px-1 rounded">claudechat</code> to start a session with MCP Chat channels enabled.
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
            <p className="text-sm font-medium">Do I need to start every session with the channels flag?</p>
            <p className="text-sm text-muted-foreground">
              Yes, for live message receiving. Without <code className="bg-muted px-1 rounded">--channels</code>,
              you can still use the tools to send and read messages manually, but you won't get real-time push notifications.
              Use the shell alias to make this automatic.
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
