import Placeholder from '../components/Placeholder'

export default function Dashboard() {
  return (
    <Placeholder title="Today">
      <li>Today's intake against the daily goal</li>
      <li>Live list of sips and reminders, via Supabase Realtime</li>
      <li>Coaster and watch status, from the last_seen heartbeats</li>
      <li>"Remind her now" and time-lapse buttons</li>
    </Placeholder>
  )
}
