import { useAuth } from '@/context/AuthContext.jsx'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Menu, PanelLeftClose, PanelLeft, LogOut } from 'lucide-react'

export default function AppHeader({ onToggleSidebar, onToggleMobileSidebar, sidebarCollapsed }) {
  const { user, logout } = useAuth()

  return (
    <header className="flex h-16 items-center justify-between border-b px-4 shrink-0">
      <div className="flex items-center gap-2">
        <button
          onClick={onToggleMobileSidebar}
          className="flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent transition-colors lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <button
          onClick={onToggleSidebar}
          className="hidden lg:flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent transition-colors"
        >
          {sidebarCollapsed ? <PanelLeft className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Avatar className="h-8 w-8">
            <AvatarImage src={user?.avatar_url} alt={user?.name} />
            <AvatarFallback>{user?.name?.[0]?.toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="hidden sm:inline text-sm font-medium">{user?.name}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={logout}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
