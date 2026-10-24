import { supabase } from './supabase'

// Web Push on this device: register the service worker, subscribe, and save
// the subscription to push_subscriptions so send-push can reach it.

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY

export type PushState =
  | 'unsupported'   // no service worker / PushManager (e.g. iPhone Safari outside the home screen app)
  | 'needs-install' // iPhone/iPad: push only works once added to the home screen
  | 'denied'        // the user blocked notifications; only browser settings can undo it
  | 'off'           // supported, not subscribed yet
  | 'on'            // subscribed and saved

const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS reports itself as a Mac; touch support gives it away.
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.error('Service worker registration failed', err)
  })
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // ready never rejects; it waits for the registration in registerServiceWorker().
  return navigator.serviceWorker.ready
}

export async function getPushState(): Promise<PushState> {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (!supported) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'

  // getRegistration, not ready: ready would hang if registration had failed.
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub || Notification.permission !== 'granted' || !supabase) return 'off'

  // A browser subscription only counts if the server has it for this user.
  const { data } = await supabase.from('push_subscriptions').select('id').eq('endpoint', sub.endpoint).maybeSingle()
  return data ? 'on' : 'off'
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64Url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64Url.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function save(sub: PushSubscription, userId: string) {
  if (!supabase) throw new Error('Supabase is not configured')
  const json = sub.toJSON()
  return supabase.from('push_subscriptions').upsert(
    { user_id: userId, endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    { onConflict: 'endpoint' },
  )
}

/**
 * Asks for permission and subscribes. Must be called straight from a tap:
 * iPhones refuse the permission prompt otherwise.
 */
export async function enablePush(): Promise<PushState> {
  if (!supabase) throw new Error('Supabase is not configured')
  if (!VAPID_PUBLIC_KEY) throw new Error('VITE_VAPID_PUBLIC_KEY is missing from app/.env')

  // Ask first, before any await, so the prompt still counts as user-initiated.
  const permission = await Notification.requestPermission()
  if (permission === 'denied') return 'denied'
  if (permission !== 'granted') return 'off'

  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) throw new Error('Not signed in')

  const reg = await registration()
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }

  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe(options)

  let { error } = await save(sub, auth.user.id)
  if (error) {
    // The endpoint is already saved under another account (someone else
    // signed in on this browser before), or the VAPID key changed. A fresh
    // subscription gets a new endpoint that belongs to this user.
    await sub.unsubscribe()
    sub = await reg.pushManager.subscribe(options)
    ;({ error } = await save(sub, auth.user.id))
    if (error) throw new Error(error.message)
  }
  return 'on'
}

/** Stops push on this device and forgets it on the server. Safe to call when off. */
export async function disablePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  if (supabase) await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}

export interface SendResult { sent: number; removed: number; failed: number }

/** Calls send-push. kind 'test' goes to my own devices; the others to the account's circle. */
export async function sendPush(
  body: { kind: 'test' } | { kind: 'summary'; main_id: string; date?: string } | { kind: 'behind'; main_id: string },
): Promise<SendResult> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase.functions.invoke('send-push', { body })
  if (error) {
    // FunctionsHttpError carries the function's JSON reply in context.
    let message = error.message
    try {
      const reply = await (error as { context?: Response }).context?.json()
      if (reply?.error) message = reply.error
    } catch { /* not JSON */ }
    throw new Error(message)
  }
  return data as SendResult
}
