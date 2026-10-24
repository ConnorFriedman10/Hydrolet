// send-push: sends Web Push notifications to caregivers.
//
// Deployed with JWT verification OFF (see supabase/config.toml), because
// pg_cron has no JWT to send. Every request is authenticated here instead:
//   - pg_cron (daily summary, behind-schedule check): X-Cron-Secret header,
//     checked against Vault by check_cron_secret()
//   - a script with the service role key as the bearer token
//   - the app, with a signed-in user's token, verified with auth.getUser()
//     ("Send a test", "Send today's summary now")
//
// POST body:
//   { "kind": "test" }                                   the caller's own devices
//   { "kind": "summary", "main_id": uuid, "date"?: ... } that day's summary
//   { "kind": "behind",  "main_id": uuid }               today's numbers so far
//
// summary and behind go to the main account and everyone who takes care of it.
// A user may only trigger them for an account they have access to. Whether the
// account is actually behind is the caller's decision; this function only sends.
//
// Secrets (supabase secrets set ...): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
// (base64url, as printed by `npx web-push generate-vapid-keys`) and
// VAPID_SUBJECT (a mailto: or https: URL push services can contact).
// Subscriptions the push service reports as gone are deleted.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import * as webpush from 'jsr:@negrel/webpush@0.5.0'
import {
  behindPayload,
  parseRequest,
  summaryPayload,
  testPayload,
  vapidJwks,
  type PushPayload,
  type SummaryRow,
} from './logic.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// One application server per isolate; importing keys is the slow part.
let appServer: Promise<webpush.ApplicationServer> | null = null
function getAppServer(): Promise<webpush.ApplicationServer> {
  if (!appServer) {
    appServer = (async () => {
      const pub = Deno.env.get('VAPID_PUBLIC_KEY')
      const priv = Deno.env.get('VAPID_PRIVATE_KEY')
      if (!pub || !priv) throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY secrets are not set')
      const vapidKeys = await webpush.importVapidKeys(vapidJwks(pub, priv), { extractable: false })
      return await webpush.ApplicationServer.new({
        contactInformation: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:hydrolet@example.com',
        vapidKeys,
      })
    })()
    appServer.catch(() => { appServer = null }) // retry on the next request
  }
  return appServer
}

type Caller = { service: true } | { service: false; userId: string }

/** Who is calling, or null if the credentials are not valid. */
async function identify(req: Request): Promise<Caller | null> {
  // pg_cron: the secret only Vault knows. Checked by the database itself.
  const cronSecret = req.headers.get('x-cron-secret')
  if (cronSecret) {
    const { data, error } = await db.rpc('check_cron_secret', { p_secret: cronSecret })
    if (error) throw error
    return data === true ? { service: true } : null
  }

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  if (token === SERVICE_KEY) return { service: true }

  const { data, error } = await db.auth.getUser(token)
  if (error || !data.user) return null
  return { service: false, userId: data.user.id }
}

/** Same rule as has_access(): it's me, or it's in my caretaker_of list. */
async function callerHasAccess(userId: string, mainId: string): Promise<boolean> {
  if (userId === mainId) return true
  const { data, error } = await db.from('profiles').select('caretaker_of').eq('id', userId).maybeSingle()
  if (error) throw error
  return ((data?.caretaker_of ?? []) as string[]).includes(mainId)
}

/** The main account plus everyone whose caretaker_of lists it. */
async function circleOf(mainId: string): Promise<{ name: string; userIds: string[] }> {
  const [main, carers] = await Promise.all([
    db.from('profiles').select('id, name').eq('id', mainId).maybeSingle(),
    db.from('profiles').select('id').contains('caretaker_of', [mainId]),
  ])
  if (main.error) throw main.error
  if (carers.error) throw carers.error
  if (!main.data) throw new HttpError(404, 'Unknown account')
  return {
    name: main.data.name ?? '',
    userIds: [mainId, ...(carers.data ?? []).map((p) => p.id as string)],
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

interface SendResult {
  sent: number
  removed: number
  failed: number
}

async function sendTo(userIds: string[], payload: PushPayload): Promise<SendResult> {
  const { data: subs, error } = await db
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('user_id', userIds)
  if (error) throw error

  const result: SendResult = { sent: 0, removed: 0, failed: 0 }
  if (!subs || subs.length === 0) return result

  const server = await getAppServer()
  const text = JSON.stringify(payload)
  const gone: number[] = []

  await Promise.all(subs.map(async (s) => {
    try {
      await server
        .subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })
        .pushTextMessage(text, { urgency: webpush.Urgency.High, ttl: 12 * 60 * 60, topic: topicFor(payload.tag) })
      result.sent++
    } catch (err) {
      // 404 and 410 both mean the browser dropped this subscription.
      const status = err instanceof webpush.PushMessageError ? err.response.status : 0
      if (status === 404 || status === 410) {
        gone.push(s.id)
      } else {
        result.failed++
        console.error(`[send-push] push to subscription ${s.id} failed:`, String(err))
      }
    }
  }))

  if (gone.length > 0) {
    const { error: delError } = await db.from('push_subscriptions').delete().in('id', gone)
    if (delError) throw delError
    result.removed = gone.length
  }
  return result
}

// The Topic header must be at most 32 URL-safe base64 characters, so hash the tag.
function topicFor(tag: string): string {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (Math.imul(31, h) + tag.charCodeAt(i)) | 0
  return `h${(h >>> 0).toString(36)}`
}

async function summaryFor(mainId: string, date: string | null): Promise<SummaryRow> {
  const { data, error } = await db.rpc('compute_daily_summary', { p_main: mainId, p_date: date })
  if (error) throw error
  return data as SummaryRow
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })

  try {
    const caller = await identify(req)
    if (!caller) return json(401, { error: 'Not signed in' })

    let body: unknown = null
    try {
      body = await req.json()
    } catch {
      return json(400, { error: 'Body is not valid JSON' })
    }
    const request = parseRequest(body)
    if (typeof request === 'string') return json(400, { error: request })

    if (request.kind === 'test') {
      if (caller.service) return json(400, { error: 'test is for signed-in users' })
      return json(200, await sendTo([caller.userId], testPayload()))
    }

    const mainId = request.main_id!
    if (!caller.service && !(await callerHasAccess(caller.userId, mainId))) {
      return json(403, { error: 'Not allowed for this account' })
    }

    const circle = await circleOf(mainId)
    const summary = await summaryFor(mainId, request.kind === 'summary' ? request.date : null)
    const payload = request.kind === 'summary'
      ? summaryPayload(summary, circle.name)
      : behindPayload(summary, circle.name)

    return json(200, await sendTo(circle.userIds, payload))
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message })
    console.error('[send-push]', err)
    return json(500, { error: 'Server error' })
  }
})
