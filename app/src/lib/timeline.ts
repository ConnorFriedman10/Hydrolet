// Builds the Dashboard's "today" timeline: every reminder scheduled for today,
// plus any firing that didn't come from the schedule (a "remind her now").
//
// Pure logic, kept out of the component so it can be unit-tested.

import type { HydroEvent, ReminderSlot } from './types.ts'
import {
  formatTime, toMinutes, hasDay, todayIndex, nowMinutes, eventTime, eventMinutes,
} from './schedule.ts'

export type Status = 'upcoming' | 'active' | 'completed' | 'ignored' | 'not-logged'

export type Entry = {
  key: string
  minutes: number
  label: string          // "9:00 AM"
  target: number | null  // null for an unscheduled firing
  drank: number
  status: Status
  scheduled: boolean
}

export const STATUS_TEXT: Record<Status, string> = {
  upcoming: 'Upcoming',
  active: 'Drinking now',
  completed: 'Done',
  ignored: 'Ignored',
  'not-logged': 'No reminder sent',
}

/**
 * What today's reminders add up to: the day's actual target.
 *
 * Only scheduled reminders count. An on-demand "remind her now" has no planned
 * amount, so it cannot raise the target — though whatever she drinks during one
 * still counts towards it.
 */
export function scheduledTotal(entries: Entry[]): number {
  return entries
    .filter((e) => e.scheduled && e.target !== null)
    .reduce((sum, e) => sum + (e.target ?? 0), 0)
}

/**
 * A scheduled slot is matched to what happened through the 'reminder' event
 * carrying its reminder_slot_id. The sips and the closing completed/ignored
 * row share that firing's reminder_id, so they are found through it.
 */
export function buildTimeline(
  events: HydroEvent[],
  slots: ReminderSlot[],
  tz: string,
  now = new Date(),
): Entry[] {
  const today = todayIndex(tz, now)
  const minutesNow = nowMinutes(tz, now)

  const fired = events.filter((e) => e.type === 'reminder')

  const drankIn = (reminderId: string | null) =>
    events
      .filter((e) => e.type === 'sip' && reminderId !== null && e.reminder_id === reminderId)
      .reduce((sum, e) => sum + (e.amount_ml ?? 0), 0)

  const closedBy = (reminderId: string | null) =>
    reminderId === null
      ? undefined
      : events.find((e) =>
          e.reminder_id === reminderId && (e.type === 'completed' || e.type === 'ignored'))

  const entries: Entry[] = []

  for (const slot of slots) {
    if (!hasDay(slot.days_mask, today)) continue

    const firing = fired.find((e) => e.reminder_slot_id === slot.id)
    const closer = firing ? closedBy(firing.reminder_id) : undefined

    let status: Status
    if (closer) status = closer.type === 'completed' ? 'completed' : 'ignored'
    else if (firing) status = 'active'
    else status = toMinutes(slot.time_of_day) > minutesNow ? 'upcoming' : 'not-logged'

    entries.push({
      key: slot.id,
      minutes: toMinutes(slot.time_of_day),
      label: formatTime(slot.time_of_day),
      target: slot.amount_ml,
      drank: firing ? drankIn(firing.reminder_id) : 0,
      status,
      scheduled: true,
    })
  }

  // Firings with no slot behind them: a "remind her now", or a slot deleted since.
  for (const firing of fired) {
    if (firing.reminder_slot_id && slots.some((s) => s.id === firing.reminder_slot_id)) continue
    const closer = closedBy(firing.reminder_id)
    entries.push({
      key: `ev-${firing.id}`,
      minutes: eventMinutes(firing.created_at, tz),
      label: eventTime(firing.created_at, tz),
      target: null,
      drank: drankIn(firing.reminder_id),
      status: closer ? (closer.type === 'completed' ? 'completed' : 'ignored') : 'active',
      scheduled: false,
    })
  }

  return entries.sort((a, b) => a.minutes - b.minutes)
}
