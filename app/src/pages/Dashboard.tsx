import { useCallback, useEffect, useState } from 'react'
import { useSubject } from '../lib/auth'
import { supabase } from '../lib/supabase'
import type { Device, HydroEvent, ReminderSlot } from '../lib/types'
import { browserTimezone, startOfToday } from '../lib/schedule'
import { buildTimeline, scheduledTotal, STATUS_TEXT } from '../lib/timeline'
import DayTimeline from '../components/DayTimeline'

const ONLINE_WINDOW_MS = 30_000

// Events are fetched by a plain clock window rather than "since midnight", so
// the query does not have to wait for the account's timezone to load. Three
// days covers any timezone's idea of today; the rendering below narrows it.
const WINDOW_MS = 72 * 60 * 60 * 1000

export default function Dashboard() {
  const { subject, subjectId } = useSubject()
  const [events, setEvents] = useState<HydroEvent[]>([])
  const [slots, setSlots] = useState<ReminderSlot[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [msg, setMsg] = useState('')
  const [, setTick] = useState(0)

  // Falls back to this browser's zone for the moment before the profile
  // arrives; the real one then re-filters what has already been fetched.
  const tz = subject?.timezone ?? browserTimezone()

  const loadEvents = useCallback(async () => {
    if (!supabase || !subjectId) return
    const since = new Date(Date.now() - WINDOW_MS).toISOString()
    const { data } = await supabase.from('events').select('*')
      .eq('main_id', subjectId).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(500)
    setEvents((data ?? []) as HydroEvent[])
  }, [subjectId])

  const loadSlots = useCallback(async () => {
    if (!supabase || !subjectId) return
    const { data } = await supabase.from('reminder_slots').select('*').eq('main_id', subjectId)
    setSlots((data ?? []) as ReminderSlot[])
  }, [subjectId])

  const loadDevices = useCallback(async () => {
    if (!supabase || !subjectId) return
    // Named columns, not '*': the secret hash column is not readable by
    // clients, and asking for it makes Postgres refuse the whole query.
    const { data, error } = await supabase.from('devices')
      .select('id, owner_id, type, last_seen, pending_command')
      .eq('owner_id', subjectId)
    if (error) console.error('[dashboard] devices:', error.message)
    setDevices((data ?? []) as Device[])
  }, [subjectId])

  useEffect(() => {
    if (!supabase || !subjectId) return
    loadEvents(); loadSlots(); loadDevices()

    // Apply what changed instead of refetching all three tables. During
    // time-lapse this is the difference between one message and a burst of
    // queries per event.
    const scope = { schema: 'public', filter: `main_id=eq.${subjectId}` } as const
    const channel = supabase.channel(`dash-${subjectId}`)
      .on('postgres_changes', { event: 'INSERT', table: 'events', ...scope },
        (p) => setEvents((prev) => [p.new as HydroEvent, ...prev]))
      .on('postgres_changes', { event: 'UPDATE', table: 'events', ...scope },
        (p) => setEvents((prev) => prev.map((e) =>
          e.id === (p.new as HydroEvent).id ? (p.new as HydroEvent) : e)))
      .on('postgres_changes', { event: 'DELETE', table: 'events', ...scope },
        (p) => setEvents((prev) => prev.filter((e) => e.id !== (p.old as HydroEvent).id)))
      .on('postgres_changes', { event: '*', table: 'reminder_slots', ...scope },
        () => loadSlots())
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'devices', filter: `owner_id=eq.${subjectId}` },
        () => loadDevices())
      .subscribe()

    // Re-render each half minute so "Upcoming" flips over in time.
    const timer = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => { supabase?.removeChannel(channel); clearInterval(timer) }
  }, [subjectId, loadEvents, loadSlots, loadDevices])

  if (!subject) return <p className="muted">Loading…</p>

  const dayStart = startOfToday(tz).getTime()
  const today = events.filter((e) => new Date(e.created_at).getTime() >= dayStart)

  const timeline = buildTimeline(today, slots, tz)

  const total = today
    .filter((e) => e.type === 'sip')
    .reduce((sum, e) => sum + (e.amount_ml ?? 0), 0)

  // The target comes from the schedule itself — the amounts on today's
  // reminders, added up. Nobody sets it by hand.
  const target = scheduledTotal(timeline)
  const pct = target > 0 ? Math.min(100, Math.round((total / target) * 100)) : 0

  const command = async (cmd: string, okMsg: string) => {
    if (!supabase) return
    const { error } = await supabase.rpc('send_command', { p_main: subject.id, p_command: cmd })
    setMsg(error ? error.message : okMsg)
  }

  return (
    <>
      <section className="card">
        <h2>{subject.name || 'Today'}</h2>
        <div className="big">{total} <span className="muted">/ {target} mL</span></div>
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
        <DayTimeline marks={timeline.map((e) => ({
          key: e.key, minutes: e.minutes, label: e.label, status: e.status,
        }))} />
        <ul className="timeline">
          {timeline.map((e) => (
            <li key={e.key} className={`tl ${e.status}`}>
              <span className="tl-time">{e.label}</span>
              <span className="tl-body">
                <span className="tl-status">{STATUS_TEXT[e.status]}</span>
                {!e.scheduled && <span className="muted small"> · unscheduled</span>}
                <br />
                <span className="muted small">
                  {e.target === null ? `${e.drank} mL` : `${e.drank} of ${e.target} mL`}
                </span>
                {e.target !== null && e.drank > 0 && (
                  <span className="bar thin">
                    <span style={{ width: `${Math.min(100, Math.round((e.drank / e.target) * 100))}%` }} />
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Devices</h2>
        {(['coaster', 'watch'] as const).map((type) => {
          // If a device was re-registered, the old row lingers; show the one
          // that has checked in most recently.
          const d = devices
            .filter((x) => x.type === type)
            .sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? ''))[0]
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
          Send a reminder now
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
