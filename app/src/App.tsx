import { Navigate, Route, Routes } from 'react-router-dom'
import { isConfigured } from './lib/supabase'
import { useAuth } from './lib/auth'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Schedule from './pages/Schedule'
import Caregivers from './pages/Caregivers'
import Summary from './pages/Summary'
import Install from './pages/Install'
import Dev from './pages/Dev'

export default function App() {
  const { session, loading } = useAuth()

  if (!isConfigured) {
    return (
      <div className="app">
        <main>
          <section className="card">
            <h2>Supabase isn't configured</h2>
            <p className="muted">
              Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to{' '}
              <code>app/.env</code>, then restart the dev server.
            </p>
          </section>
        </main>
      </div>
    )
  }

  // Don't flash the login page while the session is still resolving.
  if (loading) return <p className="center muted">Loading…</p>

  if (!session) return <Login />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="caregivers" element={<Caregivers />} />
        <Route path="summary" element={<Summary />} />
        <Route path="install" element={<Install />} />
        <Route path="dev" element={<Dev />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
