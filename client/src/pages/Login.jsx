import { useNavigate } from 'react-router-dom'
import { GoogleLogin } from '@react-oauth/google'
import { toast } from 'sonner'
import { useAuth } from '@/context/AuthContext.jsx'
import { Radio } from 'lucide-react'

export default function Login() {
  const { loginWithGoogle, isAuthenticated } = useAuth()
  const navigate = useNavigate()

  if (isAuthenticated) {
    navigate('/', { replace: true })
    return null
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mx-auto w-full max-w-sm space-y-8 p-8">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center gap-2">
            <Radio className="h-10 w-10 text-primary" />
            <h1 className="text-3xl font-bold">MCP Chat</h1>
          </div>
          <p className="text-center text-muted-foreground">
            Real-time team messaging for Claude Code sessions
          </p>
          <p className="text-center text-xs text-muted-foreground">
            First user becomes admin. All others need an invite.
          </p>
        </div>

        <div className="flex justify-center">
          <GoogleLogin
            onSuccess={async (credentialResponse) => {
              try {
                await loginWithGoogle(credentialResponse.credential)
                navigate('/', { replace: true })
              } catch (err) {
                toast.error(err.response?.data?.error || 'Login failed. You may need an invite.')
              }
            }}
            onError={() => toast.error('Google login failed')}
            theme="outline"
            size="large"
            width="320"
          />
        </div>
      </div>
    </div>
  )
}
