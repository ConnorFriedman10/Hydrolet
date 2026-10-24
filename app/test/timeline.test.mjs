// Dashboard timeline: how a scheduled slot plus the events it produced turn
// into a status. Pure logic, no database — runs in milliseconds.
//
// Node runs the TypeScript source directly via --experimental-strip-types
// (see the npm scripts).

import { buildTimeline, scheduledTotal } from '../src/lib/timeline.ts'
import { createSuite, runIfMain } from './helpers.mjs'

const TZ = 'America/New_York'
const EVERY_DAY = 127

// A fixed "now": Wednesday 2026-10-28, 12:00 local (16:00 UTC, EDT).
const NOW = new Date('2026-10-28T16:00:00Z')

let nextId = 1
const slot = (time, amount = 150, days = EVERY_DAY) => ({
  id: `slot-${nextId++}`, main_id: 'm', time_of_day: time, days_mask: days, amount_ml: amount,
})
const event = (type, { at = '14:00', reminderId = null, slotId = null, ml = null } = {}) => ({
  id: nextId++,
  main_id: 'm',
  type,
  amount_ml: ml,
  reminder_id: reminderId,
  reminder_slot_id: slotId,
  created_at: `2026-10-28T${at}:00Z`,
})

export async function run() {
  const { check, results } = createSuite('timeline')
  console.log('\n--- timeline ---')

  // A slot later today that hasn't fired.
  {
    const s = slot('15:00')
    const [e] = buildTimeline([], [s], TZ, NOW)
    check('upcoming when the time is still ahead', e.status === 'upcoming', e?.status)
    check('shows its target', e.target === 150 && e.drank === 0)
    check('formats the time', e.label === '3:00 PM', e?.label)
  }

  // A slot whose time has passed with nothing logged: the device never fired.
  {
    const s = slot('09:00')
    const [e] = buildTimeline([], [s], TZ, NOW)
    check('not-logged when the time has passed silently', e.status === 'not-logged', e?.status)
  }

  // Fired, still open.
  {
    const s = slot('09:00')
    const ev = [event('reminder', { at: '13:00', reminderId: 'r1', slotId: s.id })]
    const [e] = buildTimeline(ev, [s], TZ, NOW)
    check('active once it has fired', e.status === 'active', e?.status)
  }

  // Fired, sipped, completed.
  {
    const s = slot('09:00', 200)
    const ev = [
      event('reminder', { at: '13:00', reminderId: 'r1', slotId: s.id }),
      event('sip', { at: '13:02', reminderId: 'r1', ml: 120 }),
      event('sip', { at: '13:05', reminderId: 'r1', ml: 80 }),
      event('completed', { at: '13:05', reminderId: 'r1' }),
    ]
    const [e] = buildTimeline(ev, [s], TZ, NOW)
    check('completed closes it', e.status === 'completed', e?.status)
    check('sums the sips of that firing', e.drank === 200, String(e?.drank))
  }

  // Fired and ignored.
  {
    const s = slot('09:00')
    const ev = [
      event('reminder', { at: '13:00', reminderId: 'r1', slotId: s.id }),
      event('ignored', { at: '13:10', reminderId: 'r1' }),
    ]
    const [e] = buildTimeline(ev, [s], TZ, NOW)
    check('ignored closes it', e.status === 'ignored', e?.status)
  }

  // Sips belonging to a different firing must not leak in.
  {
    const s = slot('09:00')
    const ev = [
      event('reminder', { at: '13:00', reminderId: 'r1', slotId: s.id }),
      event('sip', { at: '13:02', reminderId: 'r1', ml: 100 }),
      event('sip', { at: '13:30', reminderId: 'r2', ml: 999 }),
    ]
    const [e] = buildTimeline(ev, [s], TZ, NOW)
    check('only counts sips from its own firing', e.drank === 100, String(e?.drank))
  }

  // A slot that doesn't run today is left out.
  {
    const wednesday = 1 << 3
    const thursday = 1 << 4
    const entries = buildTimeline([], [slot('10:00', 150, thursday)], TZ, NOW)
    check('slot for another weekday is excluded', entries.length === 0)
    const onToday = buildTimeline([], [slot('10:00', 150, wednesday)], TZ, NOW)
    check("today's weekday is included", onToday.length === 1)
  }

  // "Remind her now": a firing with no slot behind it.
  {
    const ev = [event('reminder', { at: '14:30', reminderId: 'r9', slotId: null, ml: null })]
    const [e] = buildTimeline(ev, [], TZ, NOW)
    check('unscheduled firing appears', e !== undefined && e.scheduled === false)
    check('unscheduled firing has no target', e?.target === null)
    check('unscheduled firing sits at its real time', e?.label === '10:30 AM', e?.label)
  }

  // A firing whose slot was deleted since also shows as unscheduled.
  {
    const ev = [event('reminder', { at: '13:00', reminderId: 'r1', slotId: 'slot-gone' })]
    const [e] = buildTimeline(ev, [], TZ, NOW)
    check('firing from a deleted slot still shows', e !== undefined && e.scheduled === false)
  }

  // Ordering.
  {
    const entries = buildTimeline(
      [event('reminder', { at: '15:00', reminderId: 'r9' })],  // 11:00 local
      [slot('08:00'), slot('20:00'), slot('12:30')],
      TZ, NOW,
    )
    const order = entries.map((e) => e.label)
    check('sorted by time of day',
      JSON.stringify(order) === JSON.stringify(['8:00 AM', '11:00 AM', '12:30 PM', '8:00 PM']),
      order.join(' / '))
  }

  // The day's target: what the scheduled reminders add up to.
  {
    const slots = [slot('09:00', 150), slot('13:00', 200), slot('18:00', 250)]
    check('sums today\'s reminders', scheduledTotal(buildTimeline([], slots, TZ, NOW)) === 600)
  }
  {
    const thursday = 1 << 4
    const slots = [slot('09:00', 150), slot('10:00', 999, thursday)]
    check('ignores reminders that are not on today',
      scheduledTotal(buildTimeline([], slots, TZ, NOW)) === 150)
  }
  {
    // An on-demand "remind her now" has no planned amount, so it must not
    // raise the target, even though its sips count towards it.
    const ev = [
      event('reminder', { at: '14:30', reminderId: 'r9' }),
      event('sip', { at: '14:31', reminderId: 'r9', ml: 300 }),
    ]
    const entries = buildTimeline(ev, [slot('09:00', 150)], TZ, NOW)
    check('an unscheduled reminder does not raise the target',
      scheduledTotal(entries) === 150, String(scheduledTotal(entries)))
  }
  {
    check('no reminders means no target', scheduledTotal(buildTimeline([], [], TZ, NOW)) === 0)
  }

  return results()
}

runIfMain(import.meta.url, run)
