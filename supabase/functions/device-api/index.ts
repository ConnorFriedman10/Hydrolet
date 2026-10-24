// device-api: the only thing the coaster talks to.
//
// Deployed with JWT verification OFF (the coaster has no Supabase session).
// Every request instead carries X-Device-Id and X-Device-Secret; the secret is
// hashed with SHA-256 and compared to devices.device_secret_hash.
//
//   POST /event    one reminder/sip/refill/completed/ignored event
//   POST /checkin  heartbeat; returns today's reminders, the goal and any
//                  pending command (which is then cleared)
//
// Contract: .kiro/steering/contracts.md. Uses the service role key, which
// Supabase injects into every Edge Function; it never leaves the server.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import {
  isUuid,
  localClock,
  parseEvent,
  sha256Hex,
  timingSafeEqual,
  todayReminders,
  type SlotRow,
} from './logic.ts'

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

interface Device {
  id: string
  owner_id: string
  type: 'coaster' | 'watch'
  device_secret_hash: string
  pending_command: string | null
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The calling coaster, or null if the id/secret pair is not valid. */
async function authenticate(req: Request): Promise<Device | null> {
  const id = req.headers.get('x-device-id') ?? ''
  const secret = req.headers.get('x-device-secret') ?? ''
  if (!isUuid(id) || !secret) return null

  const { data, error } = await db
    .from('devices')
    .select('id, owner_id, type, device_secret_hash, pending_command')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error

  // Hash even when the device is unknown, so timing doesn't reveal which ids exist.
  const hash = await sha256Hex(secret)
  if (!data || !timingSafeEqual(hash, data.device_secret_hash)) return null

  // Only the coaster has internet; a watch's credentials are not valid here.
  if (data.type !== 'coaster') return null
  return data as Device
}

async function handleEvent(device: Device, body: unknown): Promise<Response> {
  const parsed = parseEvent(body)
  if (typeof parsed === 'string') return json(400, { error: parsed })

  // A slot the account doesn't own, or one deleted while the event sat in the
  // coaster's offline queue, is stored as unscheduled rather than rejected.
  // Rejecting would leave the event at the head of the queue, retried forever.
  if (parsed.reminder_slot_id) {
    const { data, error } = await db
      .from('reminder_slots')
      .select('id')
      .eq('id', parsed.reminder_slot_id)
      .eq('main_id', device.owner_id)
      .maybeSingle()
    if (error) throw error
    if (!data) parsed.reminder_slot_id = null
  }

  const { error } = await db.from('events').insert({ main_id: device.owner_id, ...parsed })
  if (error) throw error
  return json(200, { ok: true })
}

async function handleCheckin(device: Device, body: unknown): Promise<Response> {
  const watchConnected =
    !!body && typeof body === 'object' && (body as Record<string, unknown>).watch_connected === true
  const seenAt = new Date().toISOString()

  const [profile, slots] = await Promise.all([
    db.from('profiles').select('timezone, daily_goal_ml').eq('id', device.owner_id).single(),
    db.from('reminder_slots').select('id, time_of_day, days_mask, amount_ml').eq('main_id', device.owner_id),
    db.from('devices').update({ last_seen: seenAt }).eq('id', device.id),
    watchConnected
      ? db.from('devices').update({ last_seen: seenAt }).eq('owner_id', device.owner_id).eq('type', 'watch')
      : Promise.resolve({ error: null }),
  ]).then((results) => {
    for (const r of results) if (r.error) throw r.error
    return results
  })

  // Hand over the command exactly once. The clear only matches if the command
  // is still the one we read, so one queued between the read and the clear
  // survives for the next check-in instead of being lost.
  const command = device.pending_command
  if (command) {
    const { error } = await db
      .from('devices')
      .update({ pending_command: null })
      .eq('id', device.id)
      .eq('pending_command', command)
    if (error) throw error
  }

  const { timezone, daily_goal_ml } = profile.data as { timezone: string; daily_goal_ml: number }
  const clock = localClock(timezone)

  return json(200, {
    now: clock.now,
    today_reminders: todayReminders((slots.data ?? []) as SlotRow[], clock.weekday),
    daily_goal_ml,
    pending_command: command,
  })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })

  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  if (route !== 'event' && route !== 'checkin') return json(404, { error: 'Unknown route' })

  try {
    const device = await authenticate(req)
    if (!device) return json(401, { error: 'Unknown device or wrong secret' })

    let body: unknown = null
    const text = await req.text()
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        return json(400, { error: 'Body is not valid JSON' })
      }
    }

    return route === 'event' ? await handleEvent(device, body) : await handleCheckin(device, body)
  } catch (err) {
    // Details stay in the function logs; the coaster just retries.
    console.error(`[device-api] ${route}:`, err)
    return json(500, { error: 'Server error' })
  }
})
