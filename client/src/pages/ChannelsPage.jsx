import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useAuth } from '@/context/AuthContext.jsx'
import api from '@/lib/axios.js'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Plus, Hash, Users, Trash2, UserPlus, X, ChevronDown, ChevronUp } from 'lucide-react'

export default function ChannelsPage() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedMembers, setSelectedMembers] = useState([])
  const [expandedChannel, setExpandedChannel] = useState(null)

  const { data: channels = [], isLoading } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get('/api/channels').then(r => r.data),
  })

  const { data: allUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get('/api/users').then(r => r.data),
    enabled: isAdmin,
  })

  const createMutation = useMutation({
    mutationFn: (data) => api.post('/api/channels', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] })
      toast.success('Channel created')
      setShowCreate(false)
      setName('')
      setDescription('')
      setSelectedMembers([])
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create channel'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => api.delete(`/api/channels/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] })
      setExpandedChannel(null)
      toast.success('Channel deleted')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to delete channel'),
  })

  const addMemberMutation = useMutation({
    mutationFn: ({ channelId, userId }) => api.post(`/api/channels/${channelId}/members`, { user_id: userId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] })
      queryClient.invalidateQueries({ queryKey: ['channel-details'] })
      toast.success('Member added')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to add member'),
  })

  const removeMemberMutation = useMutation({
    mutationFn: ({ channelId, userId }) => api.delete(`/api/channels/${channelId}/members/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] })
      queryClient.invalidateQueries({ queryKey: ['channel-details'] })
      toast.success('Member removed')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to remove member'),
  })

  // Fetch channel details when expanded
  const { data: channelDetails } = useQuery({
    queryKey: ['channel-details', expandedChannel],
    queryFn: () => api.get(`/api/channels/${expandedChannel}`).then(r => r.data),
    enabled: !!expandedChannel,
  })

  const handleDelete = (ch) => {
    if (window.confirm(`Delete #${ch.name}? This will remove all messages and members.`)) {
      deleteMutation.mutate(ch.id)
    }
  }

  const handleCreate = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    createMutation.mutate({
      name: name.trim(),
      description: description.trim() || null,
      member_ids: selectedMembers,
    })
  }

  const toggleMember = (userId) => {
    setSelectedMembers((prev) =>
      prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]
    )
  }

  if (isLoading) return <div className="p-6">Loading...</div>

  const channelMembers = channelDetails?.members || []
  const nonMembers = allUsers.filter(u => u.is_active && !channelMembers.some(m => m.id === u.id))

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Channels</h1>
          <p className="text-muted-foreground">Manage communication channels</p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus className="mr-2 h-4 w-4" /> New Channel
        </Button>
      </div>

      {showCreate && (
        <div className="border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Create Channel</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., systematics-dev"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this channel for?"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            {isAdmin && allUsers.length > 0 && (
              <div>
                <label className="block text-sm font-medium mb-2">Add Members</label>
                <div className="flex flex-wrap gap-2">
                  {allUsers.filter(u => u.is_active).map((u) => (
                    <button
                      type="button"
                      key={u.id}
                      onClick={() => toggleMember(u.id)}
                      className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                        selectedMembers.includes(u.id)
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background hover:bg-accent border-input'
                      }`}
                    >
                      {u.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={!name.trim() || createMutation.isPending}>
                {createMutation.isPending ? 'Creating...' : 'Create Channel'}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}

      <div className="border rounded-lg divide-y">
        {channels.map((ch) => (
          <div key={ch.id}>
            <div className="flex items-center justify-between p-4">
              <button
                className="flex items-center gap-3 text-left flex-1"
                onClick={() => setExpandedChannel(expandedChannel === ch.id ? null : ch.id)}
              >
                <Hash className="h-5 w-5 text-muted-foreground" />
                <div className="flex-1">
                  <p className="font-medium">{ch.name}</p>
                  {ch.description && <p className="text-sm text-muted-foreground">{ch.description}</p>}
                </div>
                <Badge variant="secondary" className="gap-1">
                  <Users className="h-3 w-3" /> {ch.member_count || 0}
                </Badge>
                {expandedChannel === ch.id
                  ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  : <ChevronDown className="h-4 w-4 text-muted-foreground" />
                }
              </button>
              {isAdmin && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 ml-2 text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(ch)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>

            {/* Expanded: member management */}
            {expandedChannel === ch.id && channelDetails && (
              <div className="px-4 pb-4 space-y-3">
                {/* Current members */}
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Members</p>
                  {channelMembers.map((m) => (
                    <div key={m.id} className="flex items-center justify-between py-1.5">
                      <div className="flex items-center gap-2">
                        <Avatar className="h-6 w-6">
                          <AvatarImage src={m.avatar_url} />
                          <AvatarFallback className="text-xs">{m.name?.[0]}</AvatarFallback>
                        </Avatar>
                        <span className="text-sm">{m.name}</span>
                        {m.role === 'admin' && <Badge variant="outline" className="text-[10px] py-0">admin</Badge>}
                      </div>
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeMemberMutation.mutate({ channelId: ch.id, userId: m.id })}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Add members (admin only) */}
                {isAdmin && nonMembers.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Add members</p>
                    <div className="flex flex-wrap gap-1.5">
                      {nonMembers.map((u) => (
                        <button
                          key={u.id}
                          onClick={() => addMemberMutation.mutate({ channelId: ch.id, userId: u.id })}
                          className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-input bg-background hover:bg-accent transition-colors"
                        >
                          <UserPlus className="h-3 w-3" /> {u.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {channels.length === 0 && (
          <p className="p-4 text-center text-muted-foreground">No channels yet. Create one to get started.</p>
        )}
      </div>
    </div>
  )
}
