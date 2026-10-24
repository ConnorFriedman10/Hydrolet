import { useEffect } from 'react'
import { NavLink, Outlet, useSearchParams } from 'react-router-dom'
import { useSubject } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { disablePush } from '../lib/push'

// Forget this device's push subscription first, so the next person to sign in
// on it doesn't get the previous account's notifications.
async function logOut() {
  try { await disablePush() } catch { /* sign out regardless */ }
  await supabase?.auth.signOut()
}

const tabs = [
  { to: '/', label: 'Today', end: true },
  { to: '/schedule', label: 'Schedule' },
  { to: '/summary', label: 'Summary' },
  { to: '/caregivers', label: 'Family' },
]

export default function Layout() {
  const { subjects, subject, me, select } = useSubject()
  const [params, setParams] = useSearchParams()

  // Notifications link to ?main=<account id>, so tapping one about Grandma
  // switches to Grandma even if another account was selected.
  const linked = params.get('main')
  useEffect(() => {
    if (!linked || !subjects.some((p) => p.id === linked)) return
    if (subject?.id !== linked) select(linked)
    params.delete('main')
    setParams(params, { replace: true })
  }, [linked, subjects, subject, select, params, setParams])

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
        <button className="link" onClick={logOut}>Log out</button>
      </nav>
    </div>
  )
}
