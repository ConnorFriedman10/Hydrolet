// Pure helpers for device-api: no Supabase, no Deno APIs, so they can be
// tested under plain Node (see app/test/device-api.test.mjs).

export const EVENT_TYPES = ['reminder', 'sip', 'refill', 'completed', 'ignored'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export interface EventInput {
  type: EventType
  amount_ml: number | null
  reminder_id: string | null
  reminder_slot_id: string | null
}

export interface SlotRow {
  id: string
  time_of_day: string // "HH:MM:SS" from Postgres
  days_mask: number
  amount_ml: number
}

export interface TodayReminder {
  id: string
  time: string // "HH:MM"
  amount_ml: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A sip bigger than this is a sensor glitch, not a drink.
export const MAX_AMOUNT_ML = 5000

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

/** Hex SHA-256, matching encode(digest(secret, 'sha256'), 'hex') in register_device. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compares without bailing at the first differing character. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Validates a POST /event body. Returns the cleaned event, or an error string
 * suitable for a 400 response.
 */
export function parseEvent(body: unknown): EventInput | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object'
  const b = body as Record<string, unknown>

  if (!EVENT_TYPES.includes(b.type as EventType)) {
    return `type must be one of ${EVENT_TYPES.join(', ')}`
  }
  const type = b.type as EventType

  let amount: number | null = null
  if (b.amount_ml !== undefined && b.amount_ml !== null) {
    if (typeof b.amount_ml !== 'number' || !Number.isFinite(b.amount_ml)) {
      return 'amount_ml must be a number'
    }
    amount = Math.round(b.amount_ml)
    if (amount < 0 || amount > MAX_AMOUNT_ML) return `amount_ml must be 0..${MAX_AMOUNT_ML}`
  }
  if (type === 'sip' && amount === null) return 'A sip needs amount_ml'

  for (const key of ['reminder_id', 'reminder_slot_id'] as const) {
    if (b[key] !== undefined && b[key] !== null && !isUuid(b[key])) {
      return `${key} must be a UUID`
    }
  }

  return {
    type,
    amount_ml: amount,
    reminder_id: (b.reminder_id as string | undefined) ?? null,
    // Only the reminder event of a firing names its slot (contracts.md).
    reminder_slot_id: type === 'reminder' ? ((b.reminder_slot_id as string | undefined) ?? null) : null,
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * The account's local wall clock: "HH:MM", the local date "YYYY-MM-DD", and
 * the weekday index (0 = Sunday, matching days_mask bit 0).
 */
export function localClock(
  timezone: string,
  at: Date = new Date(),
): { now: string; date: string; weekday: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(at)
  } catch {
    // A bad timezone in the profile should not take the coaster offline.
    return localClock('UTC', at)
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  // Some engines render midnight as "24" even with h23; normalise it.
  const hour = get('hour') === '24' ? '00' : get('hour').padStart(2, '0')
  return {
    now: `${hour}:${get('minute').padStart(2, '0')}`,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAYS.indexOf(get('weekday')),
  }
}

/** Today's slots in time order, in the shape the coaster parses. */
export function todayReminders(slots: SlotRow[], weekday: number): TodayReminder[] {
  return slots
    .filter((s) => (s.days_mask & (1 << weekday)) !== 0)
    .map((s) => ({ id: s.id, time: s.time_of_day.slice(0, 5), amount_ml: s.amount_ml }))
    .sort((a, b) => a.time.localeCompare(b.time))
}
