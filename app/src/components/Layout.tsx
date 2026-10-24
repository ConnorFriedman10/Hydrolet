import { NavLink, Outlet } from 'react-router-dom'
import { useSubject } from '../lib/auth'
import { supabase } from '../lib/supabase'

const tabs = [
  { to: '/', label: 'Today', end: true },
  { to: '/schedule', label: 'Schedule' },
  { to: '/summary', label: 'Summary' },
  { to: '/caregivers', label: 'Family' },
]

export default function Layout() {
  const { subjects, subject, me, select } = useSubject()

  return (
    <div className="app">
      <header>
        <h1>Hydrolet</h1>
        {subjects.length > 1 && subject && (
          <select value={subject.id} onChange={(e) => select(e.target.value)} aria-label="Viewing account">
            {subjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === me?.id ? 'My account' : (p.name || 'Unnamed')}
              </option>
            ))}
          </select>
        )}
      </header>

      <main>
        <Outlet />
      </main>

      <nav>
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}>{t.label}</NavLink>
        ))}
        <button className="link" onClick={() => supabase?.auth.signOut()}>Log out</button>
      </nav>
    </div>
  )
}
