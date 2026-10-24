import { useCallback, useEffect, useState } from 'react'
import { useSubject } from '../lib/auth'
import { supabase } from '../lib/supabase'
import type { Device, HydroEvent, ReminderSlot } from '../lib/types'
import { startOfToday } from '../lib/schedule'
import { buildTimeline, STATUS_TEXT } from '../lib/timeline'

const ONLINE_WINDOW_MS = 30_000

export default function Dashboard() {
  const { subject } = useSubject()
  const [events, setEvents] = useState<HydroEvent[]>([])
  const [slots, setSlots] = useState<ReminderSlot[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [msg, setMsg] = useState('')
  const [, setTick] = useState(0)

  const mainId = subject?.id
  const tz = subject?.timezone ?? 'America/New_York'

  const loadAll = useCallback(async () => {
    if (!supabase || !mainId) return
    const since = startOfToday(tz).toISOString()
    const [ev, sl, dv] = await Promise.all([
      supabase.from('events').select('*').eq('main_id', mainId)
        .gte('created_at', since).order('created_at', { ascending: false }),
      supabase.from('reminder_slots').select('*').eq('main_id', mainId),
      supabase.from('devices').select('*').eq('owner_id', mainId),
    ])
    setEvents((ev.data ?? []) as HydroEvent[])
    setSlots((sl.data ?? []) as ReminderSlot[])
    setDevices((dv.data ?? []) as Device[])
  }, [mainId, tz])

  useEffect(() => {
    loadAll()
    if (!supabase || !mainId) return
    const channel = supabase.channel(`dash-${mainId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'events', filter: `main_id=eq.${mainId}` },
        () => loadAll())
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'devices', filter: `owner_id=eq.${mainId}` },
        () => loadAll())
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'reminder_slots', filter: `main_id=eq.${mainId}` },
        () => loadAll())
      .subscribe()
    // Re-render each minute so "Upcoming" flips over and "last seen" stays honest.
    const timer = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => { supabase?.removeChannel(channel); clearInterval(timer) }
  }, [mainId, loadAll])

  if (!subject) return <p className="muted">Loading…</p>

  const total = events
    .filter((e) => e.type === 'sip')
    .reduce((sum, e) => sum + (e.amount_ml ?? 0), 0)
  const pct = Math.min(100, Math.round((total / subject.daily_goal_ml) * 100))

  const timeline = buildTimeline(events, slots, tz)

  const command = async (cmd: string, okMsg: string) => {
    if (!supabase) return
    const { error } = await supabase.rpc('send_command', { p_main: subject.id, p_command: cmd })
    setMsg(error ? error.message : okMsg)
  }

  return (
    <>
      <section className="card">
        <h2>{subject.name || 'Today'}</h2>
        <div className="big">{total} <span className="muted">/ {subject.daily_goal_ml} mL</span></div>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
        <p className="muted small">Water drunk during reminders.</p>
      </section>

      <section className="card">
        <h2>Today</h2>
        {timeline.length === 0 && (
          <p className="muted">
            No reminders scheduled today. Add some on the Schedule page.
          </p>
        )}
        <ul className="timeline">
          {timeline.map((e) => (
            <li key={e.key} className={`tl ${e.status}`}>
              <span className="tl-time">{e.label}</span>
              <span className="tl-body">
                <span className="tl-status">{STATUS_TEXT[e.status]}</span>
                {!e.scheduled && <span className="muted small"> · unscheduled</span>}
                <br />
                <span className="muted small">
                  {e.target === null
                    ? `${e.drank} mL`
                    : `${e.drank} of ${e.target} mL`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Devices</h2>
        {(['coaster', 'watch'] as const).map((type) => {
          const d = devices.find((x) => x.type === type)
          const online = d?.last_seen && Date.now() - new Date(d.last_seen).getTime() < ONLINE_WINDOW_MS
          return (
            <p key={type}>
              <span className={`dot${online ? ' on' : ''}`} />
              {type === 'coaster' ? 'Coaster' : 'Watch'}:{' '}
              {!d ? 'not set up' : online ? 'online' : `last seen ${ago(d.last_seen)}`}
            </p>
          )
        })}
      </section>

      <section className="card">
        <h2>Actions</h2>
        <button onClick={() => command('remindNow', 'Reminder sent. It may take a few seconds.')}>
          Remind her now
        </button>
        <div className="row">
          <button className="secondary" onClick={() => command('timelapse_on', 'Time-lapse on.')}>
            Time-lapse on
          </button>
          <button className="secondary" onClick={() => command('timelapse_off', 'Time-lapse off.')}>
            Time-lapse off
          </button>
        </div>
        {msg && <p className="muted small">{msg}</p>}
      </section>
    </>
  )
}

function ago(iso: string | null) {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}
