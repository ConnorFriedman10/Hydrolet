// send-push's pure logic: request parsing, VAPID key conversion and the
// notification text. No database, no network.
//
// Imports the Edge Function's TypeScript directly via --experimental-strip-types.

import { readFileSync } from 'node:fs'
import {
  behindPayload, formatVolume, parseRequest, summaryPayload, testPayload, vapidJwks,
} from '../../supabase/functions/send-push/logic.ts'
import { createSuite, runIfMain } from './helpers.mjs'

const U1 = '0b5f3c2e-9a1d-4c7e-8f00-1234567890ab'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

const summary = (over = {}) => ({
  main_id: U1, date: '2026-10-24', total_ml: 1200, goal_ml: 1500,
  reminders_sent: 5, reminders_ignored: 1, ...over,
})

export async function run() {
  const { check, results } = createSuite('send-push')
  console.log('\n--- send-push ---')

  // --- parseRequest -------------------------------------------------------
  {
    const r = parseRequest({ kind: 'test', main_id: 'ignored' })
    check('1. test needs no main_id', typeof r === 'object' && r.kind === 'test' && r.main_id === null)
  }
  {
    const r = parseRequest({ kind: 'summary', main_id: U1, date: '2026-10-23' })
    check('2. summary with a date', typeof r === 'object' && r.main_id === U1 && r.date === '2026-10-23')
  }
  {
    const r = parseRequest({ kind: 'summary', main_id: U1 })
    check('3. summary date defaults to null (today)', typeof r === 'object' && r.date === null)
  }
  {
    const r = parseRequest({ kind: 'behind', main_id: U1, date: '2026-10-23' })
    check('4. behind ignores a date', typeof r === 'object' && r.date === null)
  }
  check('5. unknown kind is rejected', typeof parseRequest({ kind: 'spam' }) === 'string')
  check('6. summary without main_id is rejected', typeof parseRequest({ kind: 'summary' }) === 'string')
  check('7. non-uuid main_id is rejected',
    typeof parseRequest({ kind: 'behind', main_id: 'abc' }) === 'string')
  check('8. bad date is rejected',
    typeof parseRequest({ kind: 'summary', main_id: U1, date: '24/10/2026' }) === 'string')
  check('9. non-object body is rejected', typeof parseRequest(null) === 'string')

  // --- vapidJwks ----------------------------------------------------------
  // Round trip: a fresh key pair in the base64url form web-push prints, turned
  // into JWKs, must import and sign/verify with WebCrypto.
  {
    const algo = { name: 'ECDSA', namedCurve: 'P-256' }
    const pair = await crypto.subtle.generateKey(algo, true, ['sign', 'verify'])
    const rawPub = b64url(await crypto.subtle.exportKey('raw', pair.publicKey))
    const d = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d

    const jwks = vapidJwks(rawPub, d)
    const priv = await crypto.subtle.importKey('jwk', jwks.privateKey, algo, false, ['sign'])
    const pub = await crypto.subtle.importKey('jwk', jwks.publicKey, algo, true, ['verify'])
    const sig = { name: 'ECDSA', hash: 'SHA-256' }
    const data = new TextEncoder().encode('hydrolet')
    const ok = await crypto.subtle.verify(sig, pub, await crypto.subtle.sign(sig, priv, data), data)
    check('10. converted VAPID keys sign and verify', ok)
    check('11. public JWK round-trips to the same raw key',
      b64url(await crypto.subtle.exportKey('raw', pub)) === rawPub)
  }
  {
    let threw = false
    try { vapidJwks('AAAA', 'AAAA') } catch { threw = true }
    check('12. malformed keys throw a clear error', threw)
  }
  // The key the app subscribes with must be a valid point, or every
  // subscription silently fails. Value is not printed.
  {
    let key = ''
    try {
      const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      key = (env.match(/^VITE_VAPID_PUBLIC_KEY=(.*)$/m)?.[1] ?? '').trim()
    } catch { /* no .env */ }
    const raw = Buffer.from(key, 'base64url')
    check('13. app/.env VITE_VAPID_PUBLIC_KEY is a 65-byte P-256 point',
      raw.length === 65 && raw[0] === 0x04, key ? `${raw.length} bytes` : 'not set')
  }

  // --- notification text --------------------------------------------------
  check('14. volumes', formatVolume(850) === '850 mL' && formatVolume(1200) === '1.2 L'
    && formatVolume(1500) === '1.5 L' && formatVolume(2000) === '2 L', formatVolume(2000))
  {
    const p = summaryPayload(summary(), 'Grandma')
    check('15. summary body matches the plan\'s example',
      p.body === '1.2 L of 1.5 L goal drunk during reminders. 1 reminder ignored.', p.body)
    check('16. summary opens that day\'s summary page',
      p.url === `/summary?main=${U1}&date=2026-10-24` && p.title.startsWith('Grandma'), p.url)
  }
  {
    const p = summaryPayload(summary({ reminders_ignored: 0 }), '')
    check('17. none ignored, and a fallback title without a name',
      p.body.endsWith('5 reminders, none ignored.') && p.title.startsWith('Daily summary'), p.body)
  }
  {
    const p = summaryPayload(summary({ reminders_sent: 0, reminders_ignored: 0, total_ml: 0 }), 'G')
    check('18. a day with no reminders', p.body.endsWith('No reminders went off.'), p.body)
  }
  {
    const p = behindPayload(summary({ total_ml: 400 }), 'Grandma')
    check('19. behind alert opens the dashboard',
      p.url === `/?main=${U1}` && p.body.startsWith('400 mL of 1.5 L'), `${p.url} ${p.body}`)
  }
  check('20. test payload', testPayload().tag === 'test' && testPayload().url === '/')

  return results()
}

runIfMain(import.meta.url, run)
