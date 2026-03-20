import { useEffect, useRef, useState, useCallback } from 'react'

export function useWebSocket(channelId, { onSessionPresenceChange } = {}) {
  const wsRef = useRef(null)
  const [messages, setMessages] = useState([])
  const [presence, setPresence] = useState({})
  const [isConnected, setIsConnected] = useState(false)
  const reconnectTimeoutRef = useRef(null)
  const onSessionPresenceChangeRef = useRef(onSessionPresenceChange)
  onSessionPresenceChangeRef.current = onSessionPresenceChange

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
      }
    }

    ws.onclose = () => {
      setIsConnected(false)
      reconnectTimeoutRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [channelId])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
      if (wsRef.current) wsRef.current.close()
    }
  }, [connect])

  const sendMessage = useCallback((content, messageType = 'info') => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'message', content, message_type: messageType }))
    }
  }, [])

  const clearMessages = useCallback(() => setMessages([]), [])

  return { messages, presence, isConnected, sendMessage, clearMessages }
}
