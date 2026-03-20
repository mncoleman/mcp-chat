import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { GoogleLogin } from '@react-oauth/google'
import { toast } from 'sonner'
import { useAuth } from '@/context/AuthContext.jsx'
import api from '@/lib/axios.js'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Radio, Hash, Check, Terminal } from 'lucide-react'

export default function ConnectPage() {
  const [searchParams] = useSearchParams()
  const callbackUrl = searchParams.get('callback')
  const { token, user, isAuthenticated, loginWithGoogle } = useAuth()
  const [selectedChannel, setSelectedChannel] = useState(null)
  const [connecting, setConnecting] = useState(false)

  const { data: channels = [] } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get('/api/channels').then(r => r.data),
    enabled: isAuthenticated,
  })

  const handleConnect = () => {
    if (!selectedChannel || !callbackUrl) return
    setConnecting(true)

    const channel = channels.find(c => c.id === selectedChannel)
    const params = new URLSearchParams({
      token,
      channel_id: String(selectedChannel),
      channel_name: channel?.name || '',
      user_name: user?.name || '',
    })

    window.location.href = `${callbackUrl}?${params.toString()}`
  }

  if (!callbackUrl) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center space-y-4 p-8">
          <Radio className="h-12 w-12 text-primary mx-auto" />
          <h1 className="text-2xl font-bold">MCP Chat Connect</h1>
          <p className="text-muted-foreground max-w-md">
            This page is used by Claude Code to authenticate and connect to a channel.
            It should be opened automatically by the MCP server.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mx-auto w-full max-w-md space-y-8 p-8">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center gap-2">
            <Terminal className="h-8 w-8 text-primary" />
            <Radio className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">Connect Claude Code</h1>
          <p className="text-center text-muted-foreground text-sm">
            Authenticate and choose a channel for your Claude Code session
          </p>
        </div>

        {/* Step 1: Auth */}
        {!isAuthenticated ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">1</Badge>
              <span className="font-semibold">Sign in with Google</span>
            </div>
            <div className="flex justify-center">
              <GoogleLogin
                onSuccess={async (credentialResponse) => {
                  try {
                    await loginWithGoogle(credentialResponse.credential)
                  } catch (err) {
                    toast.error(err.response?.data?.error || 'Login failed')
                  }
                }}
                onError={() => toast.error('Google login failed')}
                theme="outline"
                size="large"
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <Check className="h-4 w-4 text-green-600" />
            <span>Signed in as <strong>{user?.name}</strong></span>
          </div>
        )}

        {/* Step 2: Pick channel */}
        {isAuthenticated && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge className="h-6 w-6 flex items-center justify-center rounded-full p-0">2</Badge>
              <span className="font-semibold">Choose a channel</span>
            </div>

            {channels.length === 0 ? (
              <div className="border rounded-lg p-4 text-center text-sm text-muted-foreground">
                No channels available. Ask an admin to add you to a channel.
              </div>
            ) : (
              <div className="space-y-2">
                {channels.map((ch) => (
                  <button
                    key={ch.id}
                    onClick={() => setSelectedChannel(ch.id)}
                    className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg border text-left text-sm transition-colors ${
                      selectedChannel === ch.id
                        ? 'border-primary bg-primary/5 ring-2 ring-primary'
                        : 'border-input hover:bg-accent'
                    }`}
                  >
                    <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{ch.name}</p>
                      {ch.description && (
                        <p className="text-xs text-muted-foreground truncate">{ch.description}</p>
                      )}
                    </div>
                    {selectedChannel === ch.id && (
                      <Check className="h-4 w-4 text-primary shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}

            <Button
              className="w-full"
              disabled={!selectedChannel || connecting}
              onClick={handleConnect}
            >
              {connecting ? 'Connecting...' : 'Connect Session'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
