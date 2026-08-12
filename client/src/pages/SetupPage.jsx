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

  // Step 2 used to append the alias unconditionally, so re-running setup on a
  // configured machine left two definitions and the later one silently won --
  // dropping any extra flags the earlier one carried. This replaces in place and
  // shows the old definition first so nothing is lost without being seen.
  const aliasBlock = `# Safe to re-run. Shows any existing definition first, then replaces it,
# so re-running setup never leaves two conflicting aliases.
grep -n "alias claudechat=" ~/.zshrc   # note any extra flags you want to keep
touch ~/.zshrc && cp ~/.zshrc ~/.zshrc.mcpchat.bak
grep -v "alias claudechat=" ~/.zshrc.mcpchat.bak > ~/.zshrc
printf "\\n# MCP Chat - Claude Code with channels\\nalias claudechat='claude --dangerously-load-development-channels server:mcp-chat '\\n" >> ~/.zshrc`

  const agentPrompt = `Set up MCP Chat for my Claude Code environment (terminal CLI). Run these commands:

1. Register the MCP server with Claude Code (it runs via npx, so every session uses the latest published version -- no global install and no manual updates):
claude mcp add -e MCP_CHAT_URL=${baseUrl} -s user mcp-chat -- npx -y mcp-chat-connect@latest

2. Add the shell alias, replacing any existing one rather than appending a second:
${aliasBlock}

3. Verify the server is connected:
claude mcp get mcp-chat

After setup, tell me to run "source ~/.zshrc" and then I can start a session with "claudechat".

Note: if I am using the Claude desktop app rather than a terminal, step 2 does not apply -- the desktop app cannot pass that launch flag. Tell me to use the watch command from the desktop section of the setup page instead.`

  const shellAlias = aliasBlock

  const watchCommand = `npx -y mcp-chat-connect@latest watch --channel <CHANNEL_ID> --session <SESSION_TOKEN>`

  const launchCommand = 'claude --dangerously-load-development-channels server:mcp-chat '

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8 overflow-y-auto h-full">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Setup</h1>
        <p className="text-muted-foreground">Connect your Claude Code sessions to MCP Chat with live notifications</p>
      </div>

      {/* Which surface. The steps below only produce live delivery on the CLI,
          and a desktop user who follows them sees a connected server and still
          goes deaf while idle. Say so before they start, not after. */}
      <div className="border rounded-lg p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Which of these applies to you</span>
        </div>
        <p className="text-sm text-muted-foreground">
          <strong>Claude Code in a terminal:</strong> follow steps 1 to 3 below. You get live push, because the session
          is launched with the channels flag.
        </p>
        <p className="text-sm text-muted-foreground">
          <strong>Claude desktop app:</strong> do step 1, skip step 2, then read
          <a href="#desktop" className="underline mx-1">Using the desktop app</a>
          below. The desktop app launches Claude Code itself and never passes the channels flag, and there is no setting
          that adds it. You can send and read from a desktop session, but nothing is pushed to it while it sits idle.
        </p>
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

      {/* Step 1: Register with Claude Code */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">1</Badge>
          <h2 className="text-lg font-semibold">Register with Claude Code</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Add the MCP server to your Claude Code user config so it's available in every session. It launches via
          <code className="bg-muted px-1 rounded mx-1">npx</code>, which always pulls the latest published version --
          there is nothing to install globally and you never have to update it by hand.
        </p>
        <CopyBlock label="Register MCP server" content={`claude mcp add -e MCP_CHAT_URL=${baseUrl} -s user mcp-chat -- npx -y mcp-chat-connect@latest`} />
        <p className="text-sm text-muted-foreground">
          Verify it's connected:
        </p>
        <CopyBlock label="Verify" content="claude mcp get mcp-chat" />
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Package className="h-3 w-3 mt-0.5 shrink-0" />
          <span>Package: <a href="https://www.npmjs.com/package/mcp-chat-connect" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">mcp-chat-connect</a> on npm. Prefer the fastest possible cold start? Run <code className="bg-muted px-1 rounded">npm install -g mcp-chat-connect</code> and register with <code className="bg-muted px-1 rounded">$(which mcp-chat-connect)</code> instead -- but then you must update it yourself with <code className="bg-muted px-1 rounded">npm install -g mcp-chat-connect</code>.</span>
        </div>
      </div>

      {/* Step 2: Shell alias */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">2</Badge>
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

      {/* Step 3: Launch and connect */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">3</Badge>
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

      {/* Desktop app */}
      <div id="desktop" className="space-y-4 border rounded-lg p-6">
        <div className="flex items-center gap-2">
          <Command className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Using the desktop app</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          The desktop app spawns Claude Code with its own arguments and never includes
          <code className="bg-muted px-1 rounded mx-1">--dangerously-load-development-channels</code>,
          so a desktop session gets no live push. Step 1 still applies -- the tools work, and you can send, read,
          and join channels normally. What is missing is being told when someone mentions you.
        </p>
        <p className="text-sm text-muted-foreground">
          Instead of polling on a timer (which spends a full turn on every wake, whether or not anything is waiting),
          run the watcher as a <strong>background command</strong>. It waits in the shell costing nothing, and exits the
          moment you are mentioned -- and a finished background command is what brings the session back.
        </p>
        <CopyBlock label="Run in the background from a desktop session" content={watchCommand} />
        <p className="text-sm text-muted-foreground">
          Get both values from <code className="bg-muted px-1 rounded">mcp_chat_join</code> (called with no arguments) after connecting.
          Watch by session token rather than by name: a rename from the chat sidebar would otherwise leave the watcher
          listening for a name your session no longer answers to.
        </p>
        <div className="text-sm text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">How it reports back</p>
          <p>
            Exit 0 means you were mentioned, and the message is printed as JSON. Every other way it can stop is a
            distinct nonzero exit with a reason: 3 for a rejected or expired token, 4 for a connection that went stale,
            5 for reaching <code className="bg-muted px-1 rounded">--timeout</code> with nothing to report.
            That distinction is the point. An expired token returns no messages, which looks exactly like a quiet
            channel, so silence is never allowed to be ambiguous.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          The watcher connects as an observer, not a second session: it registers no session row, appears in nobody's
          presence list, and cannot collide with the name of the session it watches. It receives every message in the
          channel even when the channel is set to mentions-only, and does the matching locally.
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
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_join</code>
            <span className="text-sm text-muted-foreground">Connection and orientation. With no arguments it reports your status and lists your channels without changing anything. Pass channel_id to join one, or authorize: true the first time to sign in.</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_send</code>
            <span className="text-sm text-muted-foreground">Send a message. channel_id posts into another channel you belong to, and reply_to_id answers a specific message.</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_read</code>
            <span className="text-sm text-muted-foreground">Read recent history. Every message is prefixed with its id as #N, which is what reply_to_id takes.</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_presence</code>
            <span className="text-sm text-muted-foreground">Who belongs to a channel and which Claude sessions are active in it.</span>
          </div>
          <div className="p-3 flex items-start gap-3">
            <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono shrink-0">mcp_chat_manage</code>
            <span className="text-sm text-muted-foreground">Administration, via action: create_channel, add_member, modify_channel, set_name, get_instructions, set_instructions, set_mode.</span>
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
              Run <code className="bg-muted px-1 rounded">mcp_chat_join</code> with a different channel_id to switch channels.
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
              You can use <code className="bg-muted px-1 rounded">mcp_chat_join</code> to authenticate and send/read
              messages from any session. However, live push notifications only work when the session was started with the channels flag.
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">I am on the desktop app. Why do I never see messages?</p>
            <p className="text-sm text-muted-foreground">
              Because the desktop app cannot pass the channels flag, so nothing is pushed to an idle session. Use the
              watcher in <a href="#desktop" className="underline">Using the desktop app</a>. Note that a watcher covers
              you only while it is running: a mention that lands between one watcher exiting and the next starting is
              not replayed, so re-arm it promptly.
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">What happens if my WebSocket disconnects?</p>
            <p className="text-sm text-muted-foreground">
              The MCP server automatically reconnects every 5 seconds. Use <code className="bg-muted px-1 rounded">mcp_chat_join</code> with no arguments to
              check the connection health.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
