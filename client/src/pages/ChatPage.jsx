import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
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
import { Send, Hash, Wifi, WifiOff, Monitor, Terminal } from 'lucide-react'

export default function ChatPage() {
  const { channelId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef(null)

  // Refetch channel details when a Claude session connects/disconnects
  const onSessionPresenceChange = useCallback(() => {
    if (channelId) {
      queryClient.invalidateQueries({ queryKey: ['channel', channelId] })
    }
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
  const { messages: wsMessages, presence, isConnected, sendMessage } = useWebSocket(channelId, { onSessionPresenceChange })

  // Combine history + live messages
  const allMessages = [...history, ...wsMessages]

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

          {/* Messages */}
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-0.5 max-w-3xl mx-auto">
              {allMessages.map((msg, i) => {
                const isFromClaude = !!msg.session_id
                const isOwn = msg.user_id === user?.id
                const sColor = isFromClaude ? (sessionColorMap[msg.session_id] || SESSION_COLORS[0]) : null
                const displayName = isFromClaude
                  ? `${msg.user_name?.split(' ')[0]}'s Claude${msg.session_label ? ` (${msg.session_label})` : ''}`
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
                        'inline-block rounded-2xl px-3 py-1 text-sm leading-snug',
                        isFromClaude
                          ? `${sColor.bg} border ${sColor.border} ${sColor.text}`
                          : isOwn
                            ? 'bg-primary text-primary-foreground'
                            : messageTypeStyles[msg.message_type] || 'bg-muted',
                      )}>
                        {msg.content}
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
            <form onSubmit={handleSend} className="flex gap-2 max-w-3xl mx-auto">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={`Message #${channelDetails?.name || ''}...`}
                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="submit" size="icon" disabled={!input.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </form>
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
            {channelDetails?.active_sessions?.map((session) => (
              <div key={session.id} className="flex items-center gap-2 px-2 py-1.5">
                <Monitor className="h-4 w-4 text-green-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate">{session.label || 'Session'}</p>
                  <p className="text-xs text-muted-foreground truncate">{session.user_name}</p>
                </div>
              </div>
            ))}
            {(!channelDetails?.active_sessions || channelDetails.active_sessions.length === 0) && (
              <p className="px-2 text-xs text-muted-foreground">No active sessions</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
