// Weekday bitmask helpers and timezone-aware "today".
//
// days_mask is 7 bits, bit 0 = Sunday .. bit 6 = Saturday, matching
// Date.getDay() so no translation table is needed.
//
// "Today" is always computed in the main account's timezone, not the viewer's,
// so a caregiver checking in from another time zone still sees the day the way
// the person wearing the watch experiences it.

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const EVERY_DAY = 127
export const WEEKDAYS = 0b0111110  // Mon–Fri
export const WEEKENDS = 0b1000001  // Sat + Sun

export const bit = (day: number) => 1 << day
export const hasDay = (mask: number, day: number) => (mask & bit(day)) !== 0
export const toggleDay = (mask: number, day: number) => mask ^ bit(day)
export const daysIn = (mask: number) =>
  [0, 1, 2, 3, 4, 5, 6].filter((d) => hasDay(mask, d))

export function describeMask(mask: number): string {
  if (mask === EVERY_DAY) return 'Every day'
  if (mask === WEEKDAYS) return 'Weekdays'
  if (mask === WEEKENDS) return 'Weekends'
  const days = daysIn(mask)
  if (days.length === 0) return 'No days'
  if (days.length === 1) return DAY_NAMES[days[0]]
  return days.map((d) => DAY_SHORT[d]).join(', ')
}

/** "09:00:00" or "09:00" -> minutes since midnight. */
export function toMinutes(timeOfDay: string): number {
  const [h, m] = timeOfDay.split(':').map(Number)
  return h * 60 + m
}

/** "09:00:00" -> "9:00 AM". */
export function formatTime(timeOfDay: string): string {
  const [h, m] = timeOfDay.split(':').map(Number)
  const suffix = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

/** "09:00:00" -> "09:00", for an <input type="time">. */
export const toTimeInput = (timeOfDay: string) => timeOfDay.slice(0, 5)

/** Stand-in until the account's own timezone has loaded. */
export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

function partsIn(timeZone: string, date: Date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]))
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
  }
}

/** Weekday index (0 = Sunday) in the given timezone. */
export function todayIndex(timeZone: string, now = new Date()): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now)
  const i = DAY_SHORT.indexOf(name)
  return i >= 0 ? i : now.getDay()
}

/** Minutes since midnight, right now, in the given timezone. */
export function nowMinutes(timeZone: string, now = new Date()): number {
  const { hour, minute } = partsIn(timeZone, now)
  return hour * 60 + minute
}

/** The instant at which "today" began in the given timezone. */
export function startOfToday(timeZone: string, now = new Date()): Date {
  return startOfDate(timeZone, localDate(timeZone, now))
}

/** Today's date in the given timezone, as "YYYY-MM-DD". */
export function localDate(timeZone: string, now = new Date()): string {
  const { year, month, day } = partsIn(timeZone, now)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** "2026-10-24" plus n days, as a date string. Calendar maths only; no timezone involved. */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** The instant at which the given local date ("YYYY-MM-DD") began in the given timezone. */
export function startOfDate(timeZone: string, ymd: string): Date {
  const [year, month, day] = ymd.split('-').map(Number)
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0)
  // How far that timezone is from UTC at that moment.
  const probe = partsIn(timeZone, new Date(guess))
  const asUtc = Date.UTC(probe.year, probe.month - 1, probe.day, probe.hour, probe.minute, probe.second)
  return new Date(guess - (asUtc - guess))
}

/** "2026-10-24" -> "Saturday, October 24". */
export function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** An event's wall-clock time in the given timezone, as "9:05 AM". */
export function eventTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso))
}

/** Minutes since midnight for an event, in the given timezone. */
export function eventMinutes(iso: string, timeZone: string): number {
  const { hour, minute } = partsIn(timeZone, new Date(iso))
  return hour * 60 + minute
}
