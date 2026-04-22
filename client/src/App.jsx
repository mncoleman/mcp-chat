import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext.jsx'
import AppLayout from './components/AppLayout.jsx'
import Login from './pages/Login.jsx'
import ChatPage from './pages/ChatPage.jsx'
import UsersPage from './pages/UsersPage.jsx'
import ChannelsPage from './pages/ChannelsPage.jsx'
import SetupPage from './pages/SetupPage.jsx'
import ConnectPage from './pages/ConnectPage.jsx'
import AuthComplete from './pages/AuthComplete.jsx'

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return children
}

function AdminRoute({ children }) {
  const { isAuthenticated, user } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/connect" element={<ConnectPage />} />
      <Route path="/auth/systematics/complete" element={<AuthComplete />} />
      <Route path="/" element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:channelId" element={<ChatPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="channels" element={<ChannelsPage />} />
        <Route path="users" element={<AdminRoute><UsersPage /></AdminRoute>} />
      </Route>
    </Routes>
  )
}
