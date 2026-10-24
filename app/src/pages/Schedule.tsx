import { useCallback, useEffect, useState } from 'react'
import { useSubject } from '../lib/auth'
import { supabase } from '../lib/supabase'
import type { ReminderSlot } from '../lib/types'
import {
  DAY_SHORT, EVERY_DAY, WEEKDAYS, WEEKENDS,
  describeMask, hasDay, toggleDay, toMinutes, formatTime, toTimeInput, todayIndex,
  browserTimezone,
} from '../lib/schedule'
import DayTimeline from '../components/DayTimeline'

type Draft = { id: string | null; time: string; days: number; amount: number }

export default function Schedule() {
  const { subject, subjectId, reload } = useSubject()
  const [slots, setSlots] = useState<ReminderSlot[]>([])
  const [day, setDay] = useState(0)
  const [goal, setGoal] = useState(1500)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // subjectId is known before the profile loads, so the slots query starts
  // straight away rather than queueing behind it.
  const mainId = subjectId
  const tz = subject?.timezone ?? browserTimezone()

  // Default the day tab to the account's today.
  useEffect(() => { setDay(todayIndex(tz)) }, [tz])
  useEffect(() => { if (subject) setGoal(subject.daily_goal_ml) }, [subject?.id, subject?.daily_goal_ml])

  const load = useCallback(async () => {
    if (!supabase || !mainId) return
    const { data } = await supabase.from('reminder_slots').select('*').eq('main_id', mainId)
    setSlots((data ?? []) as ReminderSlot[])
  }, [mainId])

  useEffect(() => {
    load()
    if (!supabase || !mainId) return
    // Another caregiver editing the schedule shows up live.
    const channel = supabase.channel(`slots-${mainId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'reminder_slots', filter: `main_id=eq.${mainId}` },
        () => load())
      .subscribe()
    return () => { supabase?.removeChannel(channel) }
  }, [mainId, load])

  if (!subject) return <p className="muted">Loading…</p>

  const forDay = slots
    .filter((s) => hasDay(s.days_mask, day))
    .sort((a, b) => toMinutes(a.time_of_day) - toMinutes(b.time_of_day))
  const dayTotal = forDay.reduce((sum, s) => sum + s.amount_ml, 0)

  const lastAmount = slots.length
    ? slots[slots.length - 1].amount_ml
    : Math.round(goal / 6 / 10) * 10

  const saveGoal = async () => {
    if (!supabase) return
    const { error } = await supabase.from('profiles').update({ daily_goal_ml: goal }).eq('id', subject.id)
    setMsg(error ? error.message : 'Goal saved.')
    if (!error) reload()
  }

  const save = async () => {
    if (!supabase || !draft) return
    setBusy(true); setMsg('')
    const { error } = await supabase.rpc('upsert_reminder_slot', {
      p_main: subject.id,
      p_time: draft.time,
      p_days_mask: draft.days,
      p_amount_ml: draft.amount,
      p_id: draft.id,
    })
    if (error) setMsg(error.message)
    else { setDraft(null); await load() }
    setBusy(false)
  }

  const remove = async (id: string) => {
    if (!supabase) return
    const { error } = await supabase.rpc('delete_reminder_slot', { p_id: id })
    if (error) setMsg(error.message)
    else await load()
  }

  return (
    <>
      <section className="card">
        <h2>Daily goal</h2>
        <p className="muted small">
          Confirm this with a doctor. Some people are on a fluid limit.
        </p>
        <label>Goal (mL)
          <input type="number" min={100} max={6000} step={50} value={goal}
            onChange={(e) => setGoal(Number(e.target.value))} />
        </label>
        <button className="secondary" onClick={saveGoal}>Save goal</button>
      </section>

      <section className="card">
        <h2>Reminders</h2>
        <div className="daytabs">
          {DAY_SHORT.map((label, i) => (
            <button key={label} onClick={() => setDay(i)}
              className={`daytab${i === day ? ' on' : ''}`}>
              {label}
            </button>
          ))}
        </div>

        {forDay.length === 0 && <p className="muted">Nothing scheduled on {DAY_SHORT[day]}.</p>}

        <DayTimeline marks={forDay.map((s) => ({
          key: s.id,
          minutes: toMinutes(s.time_of_day),
          label: formatTime(s.time_of_day),
        }))} />

        <ul className="list">
          {forDay.map((s) => (
            <li key={s.id}>
              <span>
                <b>{formatTime(s.time_of_day)}</b> · {s.amount_ml} mL
                <br />
                <span className="muted small">{describeMask(s.days_mask)}</span>
              </span>
              <span className="rowbtns">
                <button className="link" onClick={() => setDraft({
                  id: s.id, time: toTimeInput(s.time_of_day), days: s.days_mask, amount: s.amount_ml,
                })}>Edit</button>
                <button className="link" onClick={() => remove(s.id)}>Delete</button>
              </span>
            </li>
          ))}
        </ul>

        {forDay.length > 0 && (
          <p className="muted small">
            {forDay.length} reminder{forDay.length === 1 ? '' : 's'} on {DAY_SHORT[day]},
            {' '}{dayTotal} mL in total.
          </p>
        )}

        {!draft && (
          <button onClick={() => setDraft({
            id: null, time: '09:00', days: EVERY_DAY, amount: lastAmount,
          })}>
            Add a reminder
          </button>
        )}
      </section>

      {draft && (
        <section className="card">
          <h2>{draft.id ? 'Edit reminder' : 'New reminder'}</h2>

          <div className="row">
            <label>Time
              <input type="time" value={draft.time}
                onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
            </label>
            <label>Amount (mL)
              <input type="number" min={1} max={2000} step={10} value={draft.amount}
                onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })} />
            </label>
          </div>

          <label>Repeats on</label>
          <div className="row">
            <button className="secondary" onClick={() => setDraft({ ...draft, days: EVERY_DAY })}>Every day</button>
            <button className="secondary" onClick={() => setDraft({ ...draft, days: WEEKDAYS })}>Weekdays</button>
            <button className="secondary" onClick={() => setDraft({ ...draft, days: WEEKENDS })}>Weekends</button>
          </div>
          <div className="daytabs">
            {DAY_SHORT.map((label, i) => (
              <button key={label} onClick={() => setDraft({ ...draft, days: toggleDay(draft.days, i) })}
                className={`daytab${hasDay(draft.days, i) ? ' on' : ''}`}>
                {label}
              </button>
            ))}
          </div>

          <div className="row">
            <button onClick={save} disabled={busy || draft.days === 0}>
              {draft.id ? 'Save changes' : 'Add reminder'}
            </button>
            <button className="secondary" onClick={() => { setDraft(null); setMsg('') }}>Cancel</button>
          </div>
          {draft.days === 0 && <p className="muted small">Pick at least one day.</p>}
        </section>
      )}

      {msg && <p className="error small">{msg}</p>}
    </>
  )
}
