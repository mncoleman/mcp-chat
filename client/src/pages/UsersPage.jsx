import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api from '@/lib/axios.js'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Mail, Plus, Copy, Check } from 'lucide-react'

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      toast.success('Copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed')
    }
  }
  return (
    <Button variant="ghost" size="sm" onClick={handleCopy} className="h-7 gap-1">
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

export default function UsersPage() {
  const queryClient = useQueryClient()
  const [inviteEmail, setInviteEmail] = useState('')

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get('/api/users').then(r => r.data),
  })

  const { data: invites = [] } = useQuery({
    queryKey: ['invites'],
    queryFn: () => api.get('/api/invites').then(r => r.data),
  })

  const roleMutation = useMutation({
    mutationFn: ({ id, role }) => api.put(`/api/users/${id}/role`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Role updated')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to update role'),
  })

  const activeMutation = useMutation({
    mutationFn: ({ id, is_active }) => api.put(`/api/users/${id}/active`, { is_active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('User status updated')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to update status'),
  })

  const createInviteMutation = useMutation({
    mutationFn: (email) => api.post('/api/invites', { email }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites'] })
      setInviteEmail('')
      toast.success('Invite created')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create invite'),
  })

  if (isLoading) return <div className="p-6">Loading...</div>

  return (
    <div className="p-6 space-y-8 overflow-y-auto h-full">
      {/* Invite Users */}
      <div className="space-y-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="text-muted-foreground">Manage members and invite new users</p>
        </div>

        <div className="border rounded-lg p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            <h2 className="font-semibold">Invite by Email</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Enter an email address. The person must sign in with Google using that exact email.
          </p>
          <form onSubmit={(e) => { e.preventDefault(); if (inviteEmail.trim()) createInviteMutation.mutate(inviteEmail.trim()) }} className="flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@example.com"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              required
            />
            <Button type="submit" disabled={!inviteEmail.trim() || createInviteMutation.isPending}>
              <Plus className="mr-2 h-4 w-4" /> Invite
            </Button>
          </form>

          {invites.length > 0 && (
            <div className="border rounded-lg divide-y">
              {invites.map((inv) => {
                const isUsed = !!inv.used_by
                const isExpired = inv.expires_at && new Date(inv.expires_at) < new Date()
                const inviteMessage = `You've been invited to MCP Chat. Sign in with your Google account (${inv.email}) at: ${window.location.origin}/login`
                return (
                  <div key={inv.id} className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium">{inv.email}</span>
                        {isUsed ? (
                          <Badge variant="secondary">Joined as {inv.used_by_name}</Badge>
                        ) : isExpired ? (
                          <Badge variant="destructive">Expired</Badge>
                        ) : (
                          <Badge variant="success">Pending</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {!isUsed && !isExpired && (
                          <CopyButton text={inviteMessage} />
                        )}
                        <span className="text-xs text-muted-foreground">
                          {new Date(inv.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Current Users */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Current Members</h2>
        <div className="border rounded-lg divide-y">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={u.avatar_url} />
                  <AvatarFallback>{u.name?.[0]?.toUpperCase()}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">{u.name}</p>
                  <p className="text-sm text-muted-foreground">{u.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>
                  {u.role}
                </Badge>
                <Badge variant={u.is_active ? 'success' : 'destructive'}>
                  {u.is_active ? 'Active' : 'Inactive'}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => roleMutation.mutate({ id: u.id, role: u.role === 'admin' ? 'user' : 'admin' })}
                >
                  {u.role === 'admin' ? 'Demote' : 'Promote'}
                </Button>
                <Button
                  variant={u.is_active ? 'destructive' : 'outline'}
                  size="sm"
                  onClick={() => activeMutation.mutate({ id: u.id, is_active: !u.is_active })}
                >
                  {u.is_active ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            </div>
          ))}
          {users.length === 0 && (
            <p className="p-4 text-center text-muted-foreground">No users yet</p>
          )}
        </div>
      </div>
    </div>
  )
}
