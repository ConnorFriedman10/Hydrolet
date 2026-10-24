import { useCallback, useEffect, useState } from 'react'
import { useSubject } from '../lib/auth'
import { supabase } from '../lib/supabase'
import type { HydroEvent, ReminderSlot } from '../lib/types'
import { formatTime, hasDay, startOfToday, todayIndex, toMinutes } from '../lib/schedule'

// Hidden page at /dev, not linked from the nav. Fakes what the coaster will
// send, so the dashboard and timeline can be built and demoed without hardware.
export default function Dev() {
  const { subject } = useSubject()
  const [slots, setSlots] = useState<ReminderSlot[]>([])
  const [events, setEvents] = useState<HydroEvent[]>([])
  const [amount, setAmount] = useState(150)
  const [out, setOut] = useState('')

  const mainId = subject?.id
  const tz = subject?.timezone ?? 'America/New_York'

  const load = useCallback(async () => {
    if (!supabase || !mainId) return
    const [sl, ev] = await Promise.all([
      supabase.from('reminder_slots').select('*').eq('main_id', mainId),
      supabase.from('events').select('*').eq('main_id', mainId)
        .gte('created_at', startOfToday(tz).toISOString())
        .order('created_at', { ascending: false }),
    ])
    setSlots((sl.data ?? []) as ReminderSlot[])
    setEvents((ev.data ?? []) as HydroEvent[])
  }, [mainId, tz])

  useEffect(() => { load() }, [load])

  if (!subject) return <p className="muted">Loading…</p>

  const today = todayIndex(tz)
  const todaysSlots = slots
    .filter((s) => hasDay(s.days_mask, today))
    .sort((a, b) => toMinutes(a.time_of_day) - toMinutes(b.time_of_day))

  // A firing is open until a completed/ignored row closes it.
  const openFiring = events.find(
    (e) => e.type === 'reminder' &&
      !events.some((x) => x.reminder_id === e.reminder_id &&
        (x.type === 'completed' || x.type === 'ignored')),
  )

  const add = async (row: Partial<HydroEvent>) => {
    if (!supabase) return
    const { error } = await supabase.from('events').insert({ main_id: subject.id, ...row })
    setOut(error ? error.message : `Added ${row.type}`)
    if (!error) await load()
  }

  const fire = (slotId: string | null) =>
    add({ type: 'reminder', reminder_id: crypto.randomUUID(), reminder_slot_id: slotId })

  const close = (type: 'completed' | 'ignored') =>
    add({ type, reminder_id: openFiring?.reminder_id ?? null })

  // Resets the dashboard between demo runs. Only today's rows, never history.
  const clearToday = async () => {
    if (!supabase) return
    if (!confirm(`Delete all ${events.length} of today's events for this account?`)) return
    const { error } = await supabase.from('events').delete()
      .eq('main_id', subject.id)
      .gte('created_at', startOfToday(tz).toISOString())
    setOut(error ? error.message : "Cleared today's events")
    if (!error) await load()
  }

  return (
    <>
      <section className="card">
        <h2>Fire a reminder</h2>
        <p className="muted small">
          Stands in for the coaster deciding it's time. Pick one of today's scheduled
          reminders, or fire an unscheduled one like "remind her now" does.
        </p>
        {todaysSlots.length === 0 && (
          <p className="muted">Nothing scheduled today — add some on the Schedule page.</p>
        )}
        <ul className="list">
          {todaysSlots.map((s) => (
            <li key={s.id}>
              <span>{formatTime(s.time_of_day)} · {s.amount_ml} mL</span>
              <button className="link" onClick={() => fire(s.id)}>Fire</button>
            </li>
          ))}
        </ul>
        <button className="secondary" onClick={() => fire(null)}>
          Fire an unscheduled reminder
        </button>
      </section>

      <section className="card">
        <h2>The open reminder</h2>
        {!openFiring && <p className="muted">None. Fire one above first.</p>}
        {openFiring && (
          <>
            <p className="muted small">
              {openFiring.reminder_slot_id ? 'Scheduled' : 'Unscheduled'} reminder, still open.
            </p>
            <label>Sip amount (mL)
              <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            </label>
            <button onClick={() => add({
              type: 'sip', amount_ml: amount, reminder_id: openFiring.reminder_id,
            })}>
              Simulate a sip of {amount} mL
            </button>
            <div className="row">
              <button className="secondary" onClick={() => close('completed')}>Mark completed</button>
              <button className="secondary" onClick={() => close('ignored')}>Mark ignored</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Register a device</h2>
        <p className="muted small">Shows the secret once. Copy it into coaster/src/secrets.h.</p>
        <div className="row">
          {(['coaster', 'watch'] as const).map((type) => (
            <button key={type} className="secondary" onClick={async () => {
              if (!supabase) return
              const { data, error } = await supabase.rpc('register_device', {
                p_type: type, p_owner: subject.id,
              })
              if (error) return setOut(error.message)
              const row = data[0]
              setOut(`${type}\nid: ${row.device_id}\nsecret: ${row.device_secret}\n(shown once)`)
            }}>{type}</button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Today's events ({events.length})</h2>
        <ul className="list">
          {events.slice(0, 12).map((e) => (
            <li key={e.id}>
              <span>{e.type}{e.amount_ml ? ` · ${e.amount_ml} mL` : ''}</span>
              <span className="muted small">
                {new Date(e.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </span>
            </li>
          ))}
        </ul>
        {events.length > 0 && (
          <button className="secondary" onClick={clearToday}>
            Clear today's events
          </button>
        )}
      </section>

      {out && <pre className="card">{out}</pre>}
    </>
  )
}
