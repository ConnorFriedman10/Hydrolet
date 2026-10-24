import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSubject } from '../lib/auth'
import { supabase } from '../lib/supabase'
import type { HydroEvent, ReminderSlot, Summary as SummaryRow } from '../lib/types'
import { addDays, browserTimezone, eventTime, formatDate, localDate, startOfDate } from '../lib/schedule'
import { buildDay, STATUS_TEXT } from '../lib/timeline'
import { sendPush } from '../lib/push'
import { clock, describe, headline, OUTCOME_TEXT, volume, type DailyReport } from '../lib/report'
import DayTimeline from '../components/DayTimeline'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HISTORY_DAYS = 14

// One day: the total against the goal, the daily report on drinking patterns,
// then each reminder with when water was drunk and how much. ?date=YYYY-MM-DD
// picks the day (the summary notification links here); no date means today, in
// the account's own timezone. The person and their caregivers all see the same
// page for the same account.
export default function Summary() {
  const { subject, subjectId } = useSubject()
  const [params, setParams] = useSearchParams()
  const [events, setEvents] = useState<HydroEvent[]>([])
  const [slots, setSlots] = useState<ReminderSlot[]>([])
  const [history, setHistory] = useState<SummaryRow[]>([])
  const [report, setReport] = useState<DailyReport | null>(null)
  const [reportMsg, setReportMsg] = useState('')
  const [reportBusy, setReportBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [, setTick] = useState(0)

  const tz = subject?.timezone ?? browserTimezone()
  const today = localDate(tz)
  const asked = params.get('date')
  const date = asked && DATE_RE.test(asked) && asked <= today ? asked : today
  const isToday = date === today

  const loadDay = useCallback(async () => {
    if (!supabase || !subjectId) return
    const from = startOfDate(tz, date).toISOString()
    const to = startOfDate(tz, addDays(date, 1)).toISOString()
    const [ev, sl] = await Promise.all([
      supabase.from('events').select('*').eq('main_id', subjectId)
        .gte('created_at', from).lt('created_at', to)
        .order('created_at', { ascending: true }).limit(1000),
      supabase.from('reminder_slots').select('*').eq('main_id', subjectId),
    ])
    setEvents((ev.data ?? []) as HydroEvent[])
    setSlots((sl.data ?? []) as ReminderSlot[])
    setLoaded(true)
  }, [subjectId, tz, date])

  const loadHistory = useCallback(async () => {
    if (!supabase || !subjectId) return
    const { data } = await supabase.from('summaries').select('*').eq('main_id', subjectId)
      .order('date', { ascending: false }).limit(HISTORY_DAYS)
    setHistory((data ?? []) as SummaryRow[])
  }, [subjectId])

  const loadReport = useCallback(async () => {
    if (!supabase || !subjectId) return
    const { data } = await supabase.from('daily_reports').select('*')
      .eq('main_id', subjectId).eq('date', date).maybeSingle()
    setReport((data ?? null) as DailyReport | null)
  }, [subjectId, date])

  useEffect(() => { setLoaded(false); loadDay() }, [loadDay])
  useEffect(() => { loadHistory() }, [loadHistory])
  useEffect(() => { setReport(null); setReportMsg(''); loadReport() }, [loadReport])

  // The nightly job writes reports; show one as soon as it lands, whichever
  // account (the person or a caregiver) is looking.
  useEffect(() => {
    if (!supabase || !subjectId) return
    const channel = supabase.channel(`report-${subjectId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'daily_reports', filter: `main_id=eq.${subjectId}` },
        () => loadReport())
      .subscribe()
    return () => { supabase?.removeChannel(channel) }
  }, [subjectId, loadReport])

  const createReport = async () => {
    if (!supabase || !subjectId) return
    setReportBusy(true); setReportMsg('')
    const { data, error } = await supabase.rpc('refresh_daily_report', { p_main: subjectId, p_date: date })
    if (error) setReportMsg(error.message)
    else setReport(data as DailyReport)
    setReportBusy(false)
  }

  // The database keeps summaries current as events arrive and the goal
  // changes, so the history list just listens.
  useEffect(() => {
    if (!supabase || !subjectId) return
    const channel = supabase.channel(`summaries-${subjectId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'summaries', filter: `main_id=eq.${subjectId}` },
        () => loadHistory())
      .subscribe()
    return () => { supabase?.removeChannel(channel) }
  }, [subjectId, loadHistory])

  // Today stays live, so a time-lapse run fills in as it happens.
  useEffect(() => {
    if (!supabase || !subjectId || !isToday) return
    const channel = supabase.channel(`summary-${subjectId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'events', filter: `main_id=eq.${subjectId}` },
        () => loadDay())
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'reminder_slots', filter: `main_id=eq.${subjectId}` },
        () => loadDay())
      .subscribe()
    const timer = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => { supabase?.removeChannel(channel); clearInterval(timer) }
  }, [subjectId, isToday, loadDay])

  if (!subject) return <p className="muted">Loading…</p>

  const goTo = (d: string) => {
    const next = new URLSearchParams(params)
    if (d >= today) next.delete('date')
    else next.set('date', d)
    setParams(next)
    setMsg('')
  }

  const day = buildDay(events, slots, tz, date)
  // The goal on record for that day, if the evening summary saved one.
  const goal = history.find((h) => h.date === date)?.goal_ml ?? subject.daily_goal_ml
  const pct = goal > 0 ? Math.min(100, Math.round((day.total / goal) * 100)) : 0

  const sipsFor = (reminderId: string | null) =>
    reminderId === null ? [] : day.events.filter((e) => e.type === 'sip' && e.reminder_id === reminderId)

  const sendNow = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await sendPush({ kind: 'summary', main_id: subject.id, date })
      setMsg(r.sent > 0
        ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}.`
        : 'Saved, but no one has notifications on yet. Turn them on from the Family page.')
      await loadHistory()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  return (
    <>
      <section className="card">
        <div className="daynav">
          <button className="secondary" onClick={() => goTo(addDays(date, -1))} aria-label="Previous day">‹</button>
          <h2>{isToday ? 'Today' : formatDate(date)}</h2>
          <button className="secondary" onClick={() => goTo(addDays(date, 1))} disabled={isToday}
            aria-label="Next day">›</button>
        </div>
        {isToday && <p className="muted small center-text">{formatDate(date)}</p>}

        <div className="big">{day.total} <span className="muted">/ {goal} mL goal</span></div>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
        <p className="muted small">Water drunk during reminders.</p>
        <p className="small">
          {day.sent === 0
            ? 'No reminders went off.'
            : `${day.sent} reminder${day.sent === 1 ? '' : 's'} went off, ${day.ignored} ignored.`}
          {day.planned > 0 && ` ${day.planned} mL was planned across the scheduled reminders.`}
        </p>
      </section>

      <section className="card" aria-labelledby="report-title">
        <h2 id="report-title">Daily report</h2>
        {!report && (
          <p className="muted small">
            {isToday
              ? "Today's report is created automatically at 8 PM, and updated just after midnight."
              : 'No report was created for this day.'}
          </p>
        )}
        {report && (
          <>
            <p className="report-headline">{headline(report.report)}</p>
            {describe(report.report).length > 0 && (
              <ul className="report-points">
                {describe(report.report).map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
            {report.report.firings.length > 0 && (
              <details className="report-firings">
                <summary>Each reminder</summary>
                <ul className="list">
                  {report.report.firings.map((f, i) => (
                    <li key={`${f.time}-${i}`}>
                      <span>
                        {clock(f.time)}
                        {!f.scheduled && <span className="muted small"> · from the app</span>}
                      </span>
                      <span className="muted small">
                        {OUTCOME_TEXT[f.outcome]} · {f.target_ml === null
                          ? volume(f.drank_ml)
                          : `${volume(f.drank_ml)} of ${volume(f.target_ml)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="muted small">
              {report.report.day_complete ? 'Final report' : 'Report so far'}, created{' '}
              {new Date(report.generated_at).toLocaleString([], {
                weekday: 'short', hour: 'numeric', minute: '2-digit',
              })}. Describes patterns only; not medical advice.
            </p>
          </>
        )}
        <button className="secondary" onClick={createReport} disabled={reportBusy}>
          {report ? 'Update report' : isToday ? "Create today's report now" : 'Create report for this day'}
        </button>
        {reportMsg && <p className="error small" role="alert">{reportMsg}</p>}
      </section>

      <section className="card">
        <h2>Reminders</h2>
        {loaded && day.entries.length === 0 && (
          <p className="muted">No reminders {isToday ? 'today' : 'this day'}.</p>
        )}
        <DayTimeline marks={day.entries.map((e) => ({
          key: e.key, minutes: e.minutes, label: e.label, status: e.status,
        }))} />
        <ul className="timeline">
          {day.entries.map((e) => {
            const sips = sipsFor(e.reminderId)
            return (
              <li key={e.key} className={`tl ${e.status}`}>
                <span className="tl-time">{e.label}</span>
                <span className="tl-body">
                  <span className="tl-status">{STATUS_TEXT[e.status]}</span>
                  {!e.scheduled && <span className="muted small"> · unscheduled</span>}
                  <br />
                  <span className="muted small">
                    {e.target === null ? `${e.drank} mL` : `${e.drank} of ${e.target} mL`}
                  </span>
                  {sips.length > 0 && (
                    <ul className="sips">
                      {sips.map((s) => (
                        <li key={s.id} className="small">
                          {eventTime(s.created_at, tz)} · {s.amount_ml ?? 0} mL
                        </li>
                      ))}
                    </ul>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
        {!isToday && slots.length > 0 && (
          <p className="muted small">
            Reminder times and amounts are shown as they are scheduled now.
          </p>
        )}
      </section>

      {history.length > 0 && (
        <section className="card">
          <h2>Past days</h2>
          <ul className="list">
            {history.map((h) => (
              <li key={h.date}>
                <button className="link" onClick={() => goTo(h.date)} aria-current={h.date === date ? 'date' : undefined}>
                  {h.date === today ? 'Today' : formatDate(h.date)}
                </button>
                <span className="muted small">
                  {h.total_ml} / {h.goal_ml} mL
                  {h.reminders_ignored > 0 && ` · ${h.reminders_ignored} ignored`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Send this summary</h2>
        <p className="muted small">
          Sends {isToday ? "today's" : "this day's"} summary to everyone with notifications on.
          It also goes out automatically each evening at 8 PM.
        </p>
        <button className="secondary" onClick={sendNow} disabled={busy}>
          Send {isToday ? "today's" : "this day's"} summary now
        </button>
        {msg && <p className="muted small" role="status">{msg}</p>}
      </section>
    </>
  )
}
