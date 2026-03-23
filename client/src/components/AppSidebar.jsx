import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useAuth } from '@/context/AuthContext.jsx'
import { MessageSquare, Users, Hash, X, Radio, Settings } from 'lucide-react'
import api from '@/lib/axios'

export default function AppSidebar({ collapsed, mobileOpen, onMobileClose }) {
  const { user } = useAuth()
  const [version, setVersion] = useState(null)

  useEffect(() => {
    api.get('/api/version').then(res => setVersion(res.data.latest)).catch(() => {})
  }, [])
  const isAdmin = user?.role === 'admin'

  const navItems = [
    { label: 'Chat', path: '/chat', icon: MessageSquare },
    { label: 'Channels', path: '/channels', icon: Hash },
    { label: 'Setup', path: '/setup', icon: Settings },
    ...(isAdmin ? [
      { label: 'Users', path: '/users', icon: Users },
    ] : []),
  ]

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all duration-300',
        collapsed ? 'w-16' : 'w-64',
        'hidden lg:flex',
        mobileOpen && '!flex',
      )}
    >
      <div
        className={cn(
          'flex h-16 items-center border-b border-sidebar-border px-4 shrink-0',
          collapsed && 'justify-center px-2',
        )}
      >
        <Radio className="h-6 w-6 text-sidebar-primary shrink-0" />
        {!collapsed && (
          <span className="ml-2 text-lg font-semibold text-sidebar-foreground truncate">
            MCP Chat
          </span>
        )}
        {mobileOpen && (
          <button
            onClick={onMobileClose}
            className="ml-auto lg:hidden flex items-center justify-center h-7 w-7 rounded-md hover:bg-sidebar-accent transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-4">
        {navItems.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={onMobileClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md mx-2 px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
                  collapsed && 'justify-center px-2',
                )
              }
              title={collapsed ? item.label : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          )
        })}
      </nav>

      {version && (
        <div className={cn(
          'px-4 py-3 border-t border-sidebar-border text-xs text-sidebar-foreground/50',
          collapsed && 'px-2 text-center',
        )}>
          {collapsed ? `v${version}` : `MCP Chat v${version}`}
        </div>
      )}
    </aside>
  )
}
