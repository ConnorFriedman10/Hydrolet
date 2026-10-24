import { NavLink, Outlet } from 'react-router-dom'

const tabs = [
  { to: '/', label: 'Today', end: true },
  { to: '/schedule', label: 'Schedule' },
  { to: '/summary', label: 'Summary' },
  { to: '/caregivers', label: 'Family' },
]

export default function Layout() {
  return (
    <div className="app">
      <header>
        <h1>Hydrolet</h1>
      </header>

      <main>
        <Outlet />
      </main>

      <nav>
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}>{t.label}</NavLink>
        ))}
      </nav>
    </div>
  )
}
