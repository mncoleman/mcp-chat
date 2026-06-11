import { useEffect, useRef, useState, useCallback } from 'react'

export function useWebSocket(channelId, { onSessionPresenceChange, onInstructionsChange } = {}) {
  const wsRef = useRef(null)
  const [messages, setMessages] = useState([])
  const [presence, setPresence] = useState({})
  const [sessionLabels, setSessionLabels] = useState({})
  const [isConnected, setIsConnected] = useState(false)
  const reconnectTimeoutRef = useRef(null)
  const onSessionPresenceChangeRef = useRef(onSessionPresenceChange)
  onSessionPresenceChangeRef.current = onSessionPresenceChange
  const onInstructionsChangeRef = useRef(onInstructionsChange)
  onInstructionsChangeRef.current = onInstructionsChange

  const connect = useCallback(() => {
    const token = localStorage.getItem('token')
    if (!token || !channelId) return

    const wsUrl = `${(import.meta.env.VITE_API_URL || 'http://localhost:4000').replace('http', 'ws')}/ws?token=${token}&channel=${channelId}`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnected(true)
    }

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.type === 'connected' && data.online) {
        // Initialize presence from server's current online list
        const initial = {}
        for (const u of data.online) {
          initial[`${u.user_id}-${u.session_token || 'browser'}`] = {
            user_id: u.user_id,
            user_name: u.user_name,
            session_token: u.session_token,
            status: 'connected',
          }
        }
        setPresence(initial)
      } else if (data.type === 'new_message') {
        setMessages((prev) => [...prev, data.message])
      } else if (data.type === 'presence') {
        setPresence((prev) => {
          const next = { ...prev }
          if (data.status === 'connected') {
            next[`${data.user_id}-${data.session_token || 'browser'}`] = {
              user_id: data.user_id,
              user_name: data.user_name,
              session_token: data.session_token,
              status: 'connected',
            }
          } else {
            delete next[`${data.user_id}-${data.session_token || 'browser'}`]
          }
          return next
        })
        // Notify when a Claude session connects/disconnects
        if (data.session_token && onSessionPresenceChangeRef.current) {
          onSessionPresenceChangeRef.current()
        }
      } else if (data.type === 'session_renamed') {
        if (data.session_token) {
          setSessionLabels((prev) => ({ ...prev, [data.session_token]: data.label }))
        }
      } else if (data.type === 'channel_instructions_updated') {
        if (onInstructionsChangeRef.current) {
          onInstructionsChangeRef.current(data.instructions, data.updated_by)
        }
      }
    }

    ws.onclose = () => {
      setIsConnected(false)
      // Only auto-reconnect if this socket is still the active one. After a
      // channel switch (or unmount) wsRef points at the new socket (or null),
      // so a superseded socket must NOT reconnect -- otherwise its stale
      // `connect` closure rebinds the WS to the previous channel and outgoing
      // messages silently land in the wrong channel.
      if (wsRef.current === ws) {
        reconnectTimeoutRef.current = setTimeout(connect, 3000)
      }
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [channelId])

  useEffect(() => {
    setMessages([])
    setPresence({})
    setSessionLabels({})
    connect()
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
      if (wsRef.current) {
        // Null the ref BEFORE close() so the socket's async onclose sees it is
        // no longer current and skips the reconnect (prevents both the
        // wrong-channel rebind on switch and a reconnect-after-unmount leak).
        const ws = wsRef.current
        wsRef.current = null
        ws.close()
      }
    }
  }, [connect])

  const sendMessage = useCallback((content, messageType = 'info') => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'message', content, message_type: messageType }))
    }
  }, [])

  const clearMessages = useCallback(() => setMessages([]), [])

  return { messages, presence, sessionLabels, isConnected, sendMessage, clearMessages }
}
