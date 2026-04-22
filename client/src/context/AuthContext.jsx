import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import api from '../lib/axios'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('token'))
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('user'))
    } catch {
      return null
    }
  })

  const saveAuth = (newToken, newUser) => {
    localStorage.setItem('token', newToken)
    localStorage.setItem('user', JSON.stringify(newUser))
    setToken(newToken)
    setUser(newUser)
  }

  const loginWithGoogle = useCallback(async (credential) => {
    const res = await api.post('/api/auth/google', { credential })
    saveAuth(res.data.token, res.data.user)
  }, [])

  const setSession = useCallback((newToken, newUser) => {
    saveAuth(newToken, newUser)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setToken(null)
    setUser(null)
  }, [])

  // Check for role changes on page load / refresh
  useEffect(() => {
    if (!token) return
    api.get('/api/auth/me').then((res) => {
      const me = res.data
      // If server sent a fresh token (role changed), update it
      if (me.token) {
        saveAuth(me.token, { id: me.id, email: me.email, name: me.name, avatar_url: me.avatar_url, role: me.role })
      } else if (me.role !== user?.role) {
        // Role changed but no new token -- update user object
        const updated = { ...user, role: me.role }
        localStorage.setItem('user', JSON.stringify(updated))
        setUser(updated)
      }
    }).catch((err) => {
      // If 403 (deactivated) or 401 (invalid token), log out
      if (err.response?.status === 403 || err.response?.status === 401) {
        logout()
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AuthContext.Provider value={{ token, user, loginWithGoogle, setSession, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
