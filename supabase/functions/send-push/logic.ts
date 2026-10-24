// send-push's pure logic: request parsing, VAPID key conversion and the
// notification text. No network, no Deno APIs, so Node can run it directly.

export type PushKind = 'test' | 'summary' | 'behind'

export interface PushRequest {
  kind: PushKind
  main_id: string | null
  date: string | null // YYYY-MM-DD in the account's timezone, summary only
}

/** What the service worker receives and turns into a notification. */
export interface PushPayload {
  title: string
  body: string
  url: string // opened when the notification is tapped
  tag: string // a newer push with the same tag replaces the older one
}

export interface SummaryRow {
  main_id: string
  date: string
  total_ml: number
  goal_ml: number
  reminders_sent: number
  reminders_ignored: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The parsed request, or an error message for a 400. */
export function parseRequest(body: unknown): PushRequest | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object'
  const b = body as Record<string, unknown>

  if (b.kind !== 'test' && b.kind !== 'summary' && b.kind !== 'behind') {
    return 'kind must be test, summary or behind'
  }
  if (b.kind === 'test') return { kind: 'test', main_id: null, date: null }

  if (typeof b.main_id !== 'string' || !UUID_RE.test(b.main_id)) return 'main_id must be a uuid'

  let date: string | null = null
  if (b.kind === 'summary' && b.date !== undefined && b.date !== null) {
    if (typeof b.date !== 'string' || !DATE_RE.test(b.date) || isNaN(Date.parse(b.date))) {
      return 'date must be YYYY-MM-DD'
    }
    date = b.date
  }
  return { kind: b.kind, main_id: b.main_id, date }
}

// ---------------------------------------------------------------------------
// VAPID keys
// ---------------------------------------------------------------------------

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Turns the usual base64url VAPID pair (what `npx web-push generate-vapid-keys`
 * prints, and what the browser's applicationServerKey takes) into the JWK pair
 * the webpush library imports. Public: 65 bytes, 0x04 || x || y. Private: d.
 */
export function vapidJwks(publicKey: string, privateKey: string): {
  publicKey: JsonWebKey
  privateKey: JsonWebKey
} {
  const pub = base64UrlToBytes(publicKey.trim())
  const d = base64UrlToBytes(privateKey.trim())
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key is not an uncompressed P-256 point')
  if (d.length !== 32) throw new Error('VAPID private key is not 32 bytes')

  const x = bytesToBase64Url(pub.slice(1, 33))
  const y = bytesToBase64Url(pub.slice(33, 65))
  const base = { kty: 'EC', crv: 'P-256', x, y, ext: true }
  return {
    publicKey: { ...base, key_ops: ['verify'] },
    privateKey: { ...base, d: bytesToBase64Url(d), key_ops: ['sign'] },
  }
}

// ---------------------------------------------------------------------------
// Notification text. Describes what happened; never gives medical advice.
// ---------------------------------------------------------------------------

/** 1200 -> "1.2 L", 850 -> "850 mL". */
export function formatVolume(ml: number): string {
  if (ml < 1000) return `${Math.round(ml)} mL`
  return `${(Math.round(ml / 100) / 10).toString()} L`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function testPayload(): PushPayload {
  return {
    title: 'Hydrolet',
    body: 'Notifications are working on this device.',
    url: '/',
    tag: 'test',
  }
}

export function summaryPayload(s: SummaryRow, name: string): PushPayload {
  const who = name.trim() || 'Daily summary'
  let reminders: string
  if (s.reminders_sent === 0) reminders = 'No reminders went off.'
  else if (s.reminders_ignored === 0) reminders = `${plural(s.reminders_sent, 'reminder')}, none ignored.`
  else reminders = `${plural(s.reminders_ignored, 'reminder')} ignored.`

  return {
    title: `${who}: ${s.date}`,
    body: `${formatVolume(s.total_ml)} of ${formatVolume(s.goal_ml)} goal drunk during reminders. ${reminders}`,
    url: `/summary?main=${s.main_id}&date=${s.date}`,
    tag: `summary-${s.main_id}-${s.date}`,
  }
}

export function behindPayload(s: SummaryRow, name: string): PushPayload {
  const who = name.trim() || 'She'
  return {
    title: `${who} is behind today`,
    body: `${formatVolume(s.total_ml)} of ${formatVolume(s.goal_ml)} goal so far, drunk during reminders.`,
    url: `/?main=${s.main_id}`,
    tag: `behind-${s.main_id}`,
  }
}
