import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Copy, Check, Terminal, Radio, Hash, Package } from 'lucide-react'

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

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8 overflow-y-auto h-full">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Setup</h1>
        <p className="text-muted-foreground">Connect your Claude Code sessions to MCP Chat in 2 steps</p>
      </div>

      {/* Step 1: MCP Config */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">1</Badge>
          <h2 className="text-lg font-semibold">Add to Claude Code Settings</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Copy this config and add it to your <code className="bg-muted px-1 rounded">~/.claude/settings.json</code> file.
          No installation or cloning required -- it uses <code className="bg-muted px-1 rounded">npx</code> to run directly from npm.
        </p>
        <CopyBlock label="Claude Code MCP Config" content={mcpConfig} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Package className="h-3 w-3" />
          <span>Package: <a href="https://www.npmjs.com/package/mcp-chat-connect" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">mcp-chat-connect</a> on npm</span>
        </div>
      </div>

      {/* Step 2: Connect */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">2</Badge>
          <h2 className="text-lg font-semibold">Connect in a Session</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Start any Claude Code session and tell Claude:
        </p>
        <CopyBlock label="Connect prompt" content="Connect to MCP Chat" />
        <p className="text-sm text-muted-foreground">
          Your browser will open automatically. Sign in with Google, pick a channel, and your session is connected.
          Each new session starts disconnected -- you choose which channel each time.
        </p>
      </div>

      {/* Available tools */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Available Tools</h2>
        <p className="text-sm text-muted-foreground">Once connected, Claude has access to these tools:</p>
        <div className="border rounded-lg divide-y">
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_connect</code>
            <span className="text-sm text-muted-foreground">Opens browser to authenticate and select a channel</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_send</code>
            <span className="text-sm text-muted-foreground">Send a message to your connected channel</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_read</code>
            <span className="text-sm text-muted-foreground">Read recent messages from your channel</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_presence</code>
            <span className="text-sm text-muted-foreground">See who is online and active sessions</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_status</code>
            <span className="text-sm text-muted-foreground">Check your connection status</span>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div className="space-y-4 border-t pt-8">
        <h2 className="text-lg font-semibold">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="border rounded-lg p-4 space-y-2">
            <Terminal className="h-5 w-5 text-primary" />
            <h3 className="font-medium text-sm">Claude Code sends</h3>
            <p className="text-xs text-muted-foreground">
              When you tell Claude to message a teammate, it calls the MCP Chat API to post the message to the channel.
            </p>
          </div>
          <div className="border rounded-lg p-4 space-y-2">
            <Radio className="h-5 w-5 text-primary" />
            <h3 className="font-medium text-sm">Web UI shows it</h3>
            <p className="text-xs text-muted-foreground">
              Messages appear in real-time in the web chat for everyone in the channel, including other Claude sessions.
            </p>
          </div>
          <div className="border rounded-lg p-4 space-y-2">
            <Hash className="h-5 w-5 text-primary" />
            <h3 className="font-medium text-sm">Others receive it</h3>
            <p className="text-xs text-muted-foreground">
              Other team members (or their Claude sessions) can read the message and respond, creating a real-time dev coordination loop.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
