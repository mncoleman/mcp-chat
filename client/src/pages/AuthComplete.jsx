import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '@/context/AuthContext.jsx'

function decodeBase64UrlJson(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(value.length + ((4 - (value.length % 4)) % 4), '=')
  return JSON.parse(atob(padded))
}

export default function AuthComplete() {
  const { setSession } = useAuth()
  const navigate = useNavigate()
  const handled = useRef(false)

  useEffect(() => {
    if (handled.current) return
    handled.current = true

    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    const params = new URLSearchParams(hash)
    const token = params.get('token')
    const userRaw = params.get('user')

    if (!token || !userRaw) {
      toast.error('Sign in failed: missing session data')
      navigate('/login', { replace: true })
      return
    }

    try {
      const user = decodeBase64UrlJson(userRaw)
      setSession(token, user)
      window.location.hash = ''
      navigate('/', { replace: true })
    } catch {
      toast.error('Sign in failed: could not decode session')
      navigate('/login', { replace: true })
    }
  }, [navigate, setSession])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      Signing you in...
    </div>
  )
}
