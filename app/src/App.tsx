import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Schedule from './pages/Schedule'
import Caregivers from './pages/Caregivers'
import Summary from './pages/Summary'
import Install from './pages/Install'
import Dev from './pages/Dev'

// No auth gate yet: every page is reachable so the skeleton can be viewed.
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="login" element={<Login />} />
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
