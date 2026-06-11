import { useState, useEffect, useRef, useCallback, useMemo, Children } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { useAuth } from '@/context/AuthContext.jsx'
import { useWebSocket } from '@/hooks/useWebSocket.js'
import api from '@/lib/axios.js'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Send, Hash, Wifi, WifiOff, Monitor, Terminal, FileText, Pencil, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const markdownComponents = {
  p: ({ node, ...props }) => <p className="my-0.5 first:mt-0 last:mb-0 whitespace-pre-wrap" {...props} />,
  a: ({ node, ...props }) => <a className="underline underline-offset-2 hover:opacity-80" target="_blank" rel="noopener noreferrer" {...props} />,
  ul: ({ node, ...props }) => <ul className="list-disc ml-5 my-1" {...props} />,
  ol: ({ node, ...props }) => <ol className="list-decimal ml-5 my-1" {...props} />,
  li: ({ node, ...props }) => <li className="my-0" {...props} />,
  h1: ({ node, ...props }) => <h1 className="text-base font-semibold mt-2 mb-1 first:mt-0" {...props} />,
  h2: ({ node, ...props }) => <h2 className="text-sm font-semibold mt-2 mb-1 first:mt-0" {...props} />,
  h3: ({ node, ...props }) => <h3 className="text-sm font-semibold mt-1.5 mb-0.5 first:mt-0" {...props} />,
  h4: ({ node, ...props }) => <h4 className="text-sm font-semibold mt-1 mb-0.5 first:mt-0" {...props} />,
  blockquote: ({ node, ...props }) => <blockquote className="border-l-2 border-current/30 pl-2 my-1 opacity-80" {...props} />,
  code: ({ node, inline, className, children, ...props }) =>
    inline ? (
      <code className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 text-[0.85em] font-mono" {...props}>{children}</code>
    ) : (
      <code className="block px-2 py-1.5 rounded bg-black/10 dark:bg-white/10 text-[0.85em] font-mono overflow-x-auto whitespace-pre" {...props}>{children}</code>
    ),
  pre: ({ node, ...props }) => <pre className="my-1 overflow-x-auto" {...props} />,
  hr: ({ node, ...props }) => <hr className="my-2 border-current/20" {...props} />,
  table: ({ node, ...props }) => <table className="my-1 border-collapse text-xs" {...props} />,
  th: ({ node, ...props }) => <th className="border border-current/20 px-1.5 py-0.5 font-semibold" {...props} />,
  td: ({ node, ...props }) => <td className="border border-current/20 px-1.5 py-0.5" {...props} />,
}

export default function ChatPage() {
  const { channelId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  // @-mention autocomplete state: { at, query, matches, index } or null when closed
  const [mention, setMention] = useState(null)

  // Channel instructions editor state
  const [showInstructions, setShowInstructions] = useState(false)
  const [editingInstructions, setEditingInstructions] = useState(false)
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)

  // Session rename state
  const [editingSessionId, setEditingSessionId] = useState(null)
  const [sessionLabelDraft, setSessionLabelDraft] = useState('')

  // Refetch channel details when a Claude session connects/disconnects
  const onSessionPresenceChange = useCallback(() => {
    if (channelId) {
      queryClient.invalidateQueries({ queryKey: ['channel', channelId] })
    }
  }, [channelId, queryClient])

  // React to live instruction changes from other members/sessions
  const onInstructionsChange = useCallback((instructions, updatedBy) => {
    if (channelId) {
      queryClient.invalidateQueries({ queryKey: ['channel', channelId] })
    }
    toast.info(updatedBy ? `${updatedBy} updated the channel instructions` : 'Channel instructions updated')
  }, [channelId, queryClient])

  // Fetch user's channels
  const { data: channels = [] } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get('/api/channels').then(r => r.data),
  })

  // Auto-select first channel
  useEffect(() => {
    if (!channelId && channels.length > 0) {
      navigate(`/chat/${channels[0].id}`, { replace: true })
    }
  }, [channelId, channels, navigate])

  // Fetch channel details
  const { data: channelDetails } = useQuery({
    queryKey: ['channel', channelId],
    queryFn: () => api.get(`/api/channels/${channelId}`).then(r => r.data),
    enabled: !!channelId,
  })

  // Fetch message history
  const { data: history = [] } = useQuery({
    queryKey: ['messages', channelId],
    queryFn: () => api.get(`/api/channels/${channelId}/messages?limit=100`).then(r => r.data),
    enabled: !!channelId,
  })

  // WebSocket for real-time
  const { messages: wsMessages, presence, sessionLabels: liveSessionLabels, isConnected, sendMessage } = useWebSocket(channelId, { onSessionPresenceChange, onInstructionsChange })

  // Combine history + live messages
  const allMessages = [...history, ...wsMessages]

  // Resolve each session's current name: active sessions + message history,
  // with live rename events (liveSessionLabels) taking precedence.
  const sessionLabelMap = useMemo(() => {
    const map = {}
    channelDetails?.active_sessions?.forEach(s => {
      if (s.session_token && s.label) map[s.session_token] = s.label
    })
    allMessages.forEach(m => {
      if (m.session_id && m.session_label && !map[m.session_id]) map[m.session_id] = m.session_label
    })
    return { ...map, ...liveSessionLabels }
  }, [channelDetails, allMessages, liveSessionLabels])

  // @-mention candidates: human members first, then connected sessions.
  // Live rename events take precedence over a session's stored label.
  const mentionCandidates = useMemo(() => {
    const seen = new Set()
    const list = []
    const add = (name, entry) => {
      if (!name) return
      const key = `${entry.type}:${name.toLowerCase()}`
      if (seen.has(key)) return
      seen.add(key)
      list.push({ name, ...entry })
    }
    channelDetails?.members?.forEach((m) => {
      if (m.id === user?.id) return // no point mentioning yourself
      add(m.name, { type: 'member', avatarUrl: m.avatar_url })
    })
    channelDetails?.active_sessions?.forEach((s) => {
      const name = (s.session_token && liveSessionLabels[s.session_token]) || s.label
      add(name, { type: 'session', sessionToken: s.session_token, userName: s.user_name })
    })
    return list
  }, [channelDetails, liveSessionLabels, user])

  // All names that should render as @mention chips: every member (incl. self, so
  // mentions of you are highlighted too) plus any session label seen, current or
  // historical. Longest first so multi-word names win over shorter prefixes.
  const knownMentionNames = useMemo(() => {
    const names = new Set()
    channelDetails?.members?.forEach((m) => m.name && names.add(m.name))
    channelDetails?.active_sessions?.forEach((s) => s.label && names.add(s.label))
    Object.values(sessionLabelMap).forEach((n) => n && names.add(n))
    return [...names].sort((a, b) => b.length - a.length)
  }, [channelDetails, sessionLabelMap])

  // Split a plain-text string into text + styled @mention chips. A span is only
  // chipped when it exactly matches a known name at a word boundary (after the
  // start or whitespace), so stray "@" and emails (foo@bar) stay plain text.
  // Output is React strings/elements (auto-escaped) -- no HTML injection.
  const splitMentions = useCallback((text) => {
    if (typeof text !== 'string' || knownMentionNames.length === 0 || !text.includes('@')) {
      return text
    }
    const out = []
    let i = 0
    let last = 0
    let key = 0
    while (i < text.length) {
      if (text[i] === '@' && (i === 0 || /\s/.test(text[i - 1]))) {
        const rest = text.slice(i + 1)
        const lowerRest = rest.toLowerCase()
        const name = knownMentionNames.find((n) => {
          if (!lowerRest.startsWith(n.toLowerCase())) return false
          const after = rest[n.length]
          return after === undefined || !/\w/.test(after)
        })
        if (name) {
          if (i > last) out.push(text.slice(last, i))
          out.push(
            <span key={`mc${key++}`} className="mention-chip mention-chip--animate">
              {text.slice(i, i + 1 + name.length)}
            </span>,
          )
          i += 1 + name.length
          last = i
          continue
        }
      }
      i += 1
    }
    if (out.length === 0) return text
    if (last < text.length) out.push(text.slice(last))
    return out
  }, [knownMentionNames])

  const applyMentions = useCallback(
    (children) => Children.map(children, (child) => (typeof child === 'string' ? splitMentions(child) : child)),
    [splitMentions],
  )

  // Message markdown renderer: same styling as the base, with @mention chips
  // injected into the text of paragraphs and list items.
  const messageMarkdownComponents = useMemo(() => ({
    ...markdownComponents,
    p: ({ node, children, ...props }) => (
      <p className="my-0.5 first:mt-0 last:mb-0 whitespace-pre-wrap" {...props}>{applyMentions(children)}</p>
    ),
    li: ({ node, children, ...props }) => (
      <li className="my-0" {...props}>{applyMentions(children)}</li>
    ),
  }), [applyMentions])

  // Assign stable colors to different Claude sessions
  const SESSION_COLORS = [
    { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-900', name: 'text-orange-700', icon: 'bg-orange-100', iconText: 'text-orange-700' },
    { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-900', name: 'text-violet-700', icon: 'bg-violet-100', iconText: 'text-violet-700' },
    { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-900', name: 'text-emerald-700', icon: 'bg-emerald-100', iconText: 'text-emerald-700' },
    { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-900', name: 'text-sky-700', icon: 'bg-sky-100', iconText: 'text-sky-700' },
    { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-900', name: 'text-rose-700', icon: 'bg-rose-100', iconText: 'text-rose-700' },
    { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-900', name: 'text-amber-700', icon: 'bg-amber-100', iconText: 'text-amber-700' },
  ]
  const sessionColorMap = useMemo(() => {
    const map = {}
    let idx = 0
    allMessages.forEach(m => {
      if (m.session_id && !map[m.session_id]) {
        map[m.session_id] = SESSION_COLORS[idx % SESSION_COLORS.length]
        idx++
      }
    })
    return map
  }, [allMessages])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [allMessages.length])

  const handleSend = (e) => {
    e.preventDefault()
    if (!input.trim()) return
    sendMessage(input.trim())
    setInput('')
    setMention(null)
  }

  // --- @-mention autocomplete ---
  // Detect an active "@query" token ending at the caret and return matching sessions.
  const detectMention = useCallback((value, caret) => {
    const beforeCaret = value.slice(0, caret)
    const at = beforeCaret.lastIndexOf('@')
    if (at === -1) return null
    // Only trigger when @ begins a token (start of input or preceded by whitespace).
    if (at > 0 && !/\s/.test(value[at - 1])) return null
    const query = beforeCaret.slice(at + 1)
    if (query.includes('\n')) return null
    const q = query.toLowerCase()
    // Prefix match so the menu closes naturally once the text stops matching a name
    // (e.g. after completing a mention and continuing the sentence).
    const matches = mentionCandidates.filter((c) => c.name.toLowerCase().startsWith(q))
    if (matches.length === 0) return null
    return { at, query, matches, index: 0 }
  }, [mentionCandidates])

  const handleComposerChange = (e) => {
    const value = e.target.value
    setInput(value)
    setMention(detectMention(value, e.target.selectionStart ?? value.length))
  }

  // Replace the "@query" token with "@<name> " and place the caret after it.
  const insertMention = (candidate) => {
    if (!mention) return
    const caret = inputRef.current?.selectionStart ?? input.length
    // If the caret moved before the @ since the menu opened, abort rather than
    // splice with a stale anchor (which could duplicate or drop text).
    if (caret < mention.at) { setMention(null); return }
    const before = input.slice(0, mention.at)
    const after = input.slice(caret)
    const inserted = `@${candidate.name} `
    setInput(before + inserted + after)
    setMention(null)
    const newCaret = before.length + inserted.length
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus()
        inputRef.current.setSelectionRange(newCaret, newCaret)
      }
    })
  }

  const handleComposerKeyDown = (e) => {
    if (!mention) return
    if (e.nativeEvent?.isComposing) return // don't hijack keys mid IME composition
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setMention((m) => m && { ...m, index: (m.index + 1) % m.matches.length })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setMention((m) => m && { ...m, index: (m.index - 1 + m.matches.length) % m.matches.length })
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Take the highlighted session instead of submitting the message
      e.preventDefault()
      insertMention(mention.matches[mention.index])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setMention(null)
    }
  }

  const openInstructionsEditor = () => {
    setInstructionsDraft(channelDetails?.instructions || '')
    setEditingInstructions(true)
    setShowInstructions(true)
  }

  const handleSaveInstructions = async () => {
    setSavingInstructions(true)
    try {
      await api.put(`/api/channels/${channelId}/instructions`, {
        instructions: instructionsDraft.trim() || null,
      })
      queryClient.invalidateQueries({ queryKey: ['channel', channelId] })
      setEditingInstructions(false)
      toast.success('Channel instructions saved')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save instructions')
    } finally {
      setSavingInstructions(false)
    }
  }

  const handleRenameSession = async (sessionId) => {
    const label = sessionLabelDraft.trim()
    if (!label) { setEditingSessionId(null); return }
    try {
      await api.patch(`/api/sessions/${sessionId}`, { label })
      queryClient.invalidateQueries({ queryKey: ['channel', channelId] })
      toast.success(`Session renamed to "${label}"`)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to rename session')
    } finally {
      setEditingSessionId(null)
    }
  }

  const messageTypeStyles = {
    info: 'bg-blue-50 border-blue-200',
    recommendation: 'bg-amber-50 border-amber-200',
    status: 'bg-green-50 border-green-200',
    system: 'bg-gray-50 border-gray-200 italic',
  }

  return (
    <div className="flex h-full">
      {/* Channel list sidebar */}
      <div className="w-60 border-r flex flex-col shrink-0">
        <div className="p-4 font-semibold text-sm text-muted-foreground uppercase tracking-wider">
          Channels
        </div>
        <div className="flex-1 overflow-y-auto">
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => navigate(`/chat/${ch.id}`)}
              className={cn(
                'flex items-center gap-2 w-full px-4 py-2 text-sm text-left hover:bg-accent transition-colors',
                String(ch.id) === String(channelId) && 'bg-accent font-medium',
              )}
            >
              <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{ch.name}</span>
            </button>
          ))}
          {channels.length === 0 && (
            <p className="px-4 py-2 text-sm text-muted-foreground">No channels yet</p>
          )}
        </div>
      </div>

      {/* Chat area */}
      {channelId ? (
        <div className="flex-1 flex flex-col">
          {/* Channel header */}
          <div className="flex items-center justify-between px-4 h-14 border-b shrink-0">
            <div className="flex items-center gap-2">
              <Hash className="h-5 w-5 text-muted-foreground" />
              <span className="font-semibold">{channelDetails?.name || 'Loading...'}</span>
              {channelDetails?.description && (
                <span className="text-sm text-muted-foreground hidden md:inline">
                  -- {channelDetails.description}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={channelDetails?.instructions ? 'secondary' : 'ghost'}
                size="sm"
                className="gap-1.5 h-8"
                onClick={() => setShowInstructions((v) => !v)}
                title="Channel instructions"
              >
                <FileText className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Instructions</span>
                {channelDetails?.instructions && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </Button>
              {isConnected ? (
                <Badge variant="success" className="gap-1">
                  <Wifi className="h-3 w-3" /> Live
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <WifiOff className="h-3 w-3" /> Disconnected
                </Badge>
              )}
            </div>
          </div>

          {/* Channel instructions panel */}
          {showInstructions && (
            <div className="border-b bg-muted/30 px-4 py-3 shrink-0">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <FileText className="h-3.5 w-3.5" /> Channel Instructions
                  </div>
                  {!editingInstructions && (
                    <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={openInstructionsEditor}>
                      <Pencil className="h-3 w-3" /> Edit
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mb-2">
                  A shared system prompt all connected Claude sessions in this channel will follow.
                </p>
                {editingInstructions ? (
                  <div className="space-y-2">
                    <textarea
                      value={instructionsDraft}
                      onChange={(e) => setInstructionsDraft(e.target.value)}
                      rows={5}
                      maxLength={10000}
                      placeholder="e.g. We are debugging the payments service. Prefer concise status updates. Flag any schema changes."
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" className="h-8 gap-1.5" onClick={handleSaveInstructions} disabled={savingInstructions}>
                        <Check className="h-3.5 w-3.5" /> Save
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => setEditingInstructions(false)} disabled={savingInstructions}>
                        <X className="h-3.5 w-3.5" /> Cancel
                      </Button>
                    </div>
                  </div>
                ) : channelDetails?.instructions ? (
                  <div className="text-sm rounded-md bg-background border px-3 py-2">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {channelDetails.instructions}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    No instructions set. <button className="underline hover:opacity-80" onClick={openInstructionsEditor}>Add some</button> to guide every session in this channel.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Messages */}
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-0.5 max-w-3xl mx-auto">
              {allMessages.map((msg, i) => {
                const isFromClaude = !!msg.session_id
                const isOwn = msg.user_id === user?.id
                const sColor = isFromClaude ? (sessionColorMap[msg.session_id] || SESSION_COLORS[0]) : null
                const resolvedLabel = isFromClaude ? sessionLabelMap[msg.session_id] : null
                const displayName = isFromClaude
                  ? `${msg.user_name?.split(' ')[0]}'s Claude${resolvedLabel ? ` (${resolvedLabel})` : ''}`
                  : msg.user_name
                const prev = allMessages[i - 1]
                const prevIsFromClaude = !!prev?.session_id
                const isGrouped = prev && prev.user_id === msg.user_id &&
                  prevIsFromClaude === isFromClaude &&
                  prev.session_id === msg.session_id &&
                  (new Date(msg.created_at) - new Date(prev.created_at)) < 120000
                const showHeader = !isGrouped

                return (
                  <div key={msg.id || `ws-${i}`} className={cn(
                    'flex gap-2',
                    isOwn && !isFromClaude && 'flex-row-reverse',
                    showHeader ? 'mt-4 first:mt-0' : 'mt-0.5',
                  )}>
                    {showHeader ? (
                      isFromClaude ? (
                        <div className={cn('h-7 w-7 shrink-0 mt-0.5 rounded-full flex items-center justify-center', sColor.icon)}>
                          <Terminal className={cn('h-3.5 w-3.5', sColor.iconText)} />
                        </div>
                      ) : (
                        <Avatar className="h-7 w-7 shrink-0 mt-0.5">
                          <AvatarImage src={msg.user_avatar} />
                          <AvatarFallback className="text-xs">{msg.user_name?.[0]?.toUpperCase()}</AvatarFallback>
                        </Avatar>
                      )
                    ) : (
                      <div className="w-7 shrink-0" />
                    )}
                    <div className={cn('max-w-[70%] min-w-0', isOwn && !isFromClaude && 'text-right')}>
                      {showHeader && (
                        <div className={cn('flex items-center gap-1.5 mb-0.5', isOwn && !isFromClaude && 'flex-row-reverse')}>
                          <span className={cn('text-xs font-medium', isFromClaude && sColor.name)}>
                            {displayName}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      )}
                      <div className={cn(
                        'inline-block rounded-2xl px-3 py-1 text-sm leading-snug break-words text-left',
                        isFromClaude
                          ? `${sColor.bg} border ${sColor.border} ${sColor.text}`
                          : isOwn
                            ? 'bg-primary text-primary-foreground'
                            : messageTypeStyles[msg.message_type] || 'bg-muted',
                      )}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={messageMarkdownComponents}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                      {msg.message_type && msg.message_type !== 'info' && !isOwn && !isFromClaude && (
                        <Badge variant="outline" className="mt-0.5 text-[10px]">{msg.message_type}</Badge>
                      )}
                    </div>
                  </div>
                )
              })}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {/* Input */}
          <div className="border-t p-4 shrink-0">
            <div className="relative max-w-3xl mx-auto">
              {mention && (
                <div
                  role="listbox"
                  className="absolute bottom-full left-0 z-50 mb-1 w-72 overflow-hidden rounded-md border bg-popover shadow-md"
                >
                  <div className="border-b px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Mention
                  </div>
                  {mention.matches.map((c, i) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === mention.index}
                      key={`${c.type}:${c.sessionToken || c.name}`}
                      onMouseDown={(e) => { e.preventDefault(); insertMention(c) }}
                      onMouseEnter={() => setMention((m) => (m ? { ...m, index: i } : m))}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                        i === mention.index ? 'bg-accent' : 'hover:bg-accent/50',
                      )}
                    >
                      {c.type === 'member' ? (
                        <Avatar className="h-4 w-4 shrink-0">
                          <AvatarImage src={c.avatarUrl} />
                          <AvatarFallback className="text-[9px]">{c.name?.[0]}</AvatarFallback>
                        </Avatar>
                      ) : (
                        <Monitor className="h-3.5 w-3.5 shrink-0 text-green-500" />
                      )}
                      <span className="truncate font-medium">{c.name}</span>
                      {(c.type === 'member' || c.userName) && (
                        <span className="ml-auto truncate text-xs text-muted-foreground">
                          {c.type === 'member' ? 'member' : c.userName}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <form onSubmit={handleSend} className="flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={handleComposerChange}
                  onKeyDown={handleComposerKeyDown}
                  onBlur={() => setMention(null)}
                  placeholder={`Message #${channelDetails?.name || ''}...`}
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button type="submit" size="icon" disabled={!input.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Select a channel to start chatting
        </div>
      )}

      {/* Presence sidebar */}
      {channelId && (
        <div className="w-56 border-l hidden xl:flex flex-col shrink-0">
          <div className="p-4 font-semibold text-sm text-muted-foreground uppercase tracking-wider">
            Online
          </div>
          <div className="flex-1 overflow-y-auto px-2">
            {/* Members */}
            {channelDetails?.members?.map((member) => {
              const memberPresence = Object.values(presence).filter(p => p.user_id === member.id)
              const isOnline = memberPresence.length > 0
              const hasClaudeSession = channelDetails?.active_sessions?.some(s => s.user_id === member.id)
              return (
                <div key={member.id} className="flex items-center gap-2 px-2 py-1.5">
                  <div className="relative">
                    <Avatar className="h-7 w-7">
                      <AvatarImage src={member.avatar_url} />
                      <AvatarFallback className="text-xs">{member.name?.[0]}</AvatarFallback>
                    </Avatar>
                    <span className={cn(
                      'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background',
                      isOnline ? 'bg-green-500' : 'bg-gray-300',
                    )} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{member.name}</p>
                    {hasClaudeSession && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Terminal className="h-3 w-3" /> Claude session
                      </p>
                    )}
                  </div>
                </div>
              )
            })}

            <Separator className="my-3" />

            {/* Active Claude sessions */}
            <div className="px-2 mb-2 text-xs font-semibold text-muted-foreground uppercase">
              Claude Sessions
            </div>
            {channelDetails?.active_sessions?.map((session) => {
              const liveLabel = (session.session_token && liveSessionLabels[session.session_token]) || session.label || 'Session'
              const isEditing = editingSessionId === session.id
              return (
                <div key={session.id} className="group flex items-center gap-2 px-2 py-1.5">
                  <Monitor className="h-4 w-4 text-green-500 shrink-0" />
                  {isEditing ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <input
                        autoFocus
                        value={sessionLabelDraft}
                        onChange={(e) => setSessionLabelDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameSession(session.id)
                          if (e.key === 'Escape') setEditingSessionId(null)
                        }}
                        maxLength={100}
                        className="flex-1 min-w-0 rounded border border-input bg-background px-1.5 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                      <button className="text-green-600 hover:opacity-80" onClick={() => handleRenameSession(session.id)} title="Save">
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button className="text-muted-foreground hover:opacity-80" onClick={() => setEditingSessionId(null)} title="Cancel">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">{liveLabel}</p>
                        <p className="text-xs text-muted-foreground truncate">{session.user_name}</p>
                      </div>
                      <button
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity shrink-0"
                        onClick={() => { setEditingSessionId(session.id); setSessionLabelDraft(liveLabel) }}
                        title="Rename session"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
            {(!channelDetails?.active_sessions || channelDetails.active_sessions.length === 0) && (
              <p className="px-2 text-xs text-muted-foreground">No active sessions</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
