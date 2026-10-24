// device-api's pure logic: event validation, the account's local clock, and
// which reminders count as "today". No database, no network.
//
// Imports the Edge Function's TypeScript directly via --experimental-strip-types.

import {
  isUuid, localClock, parseEvent, sha256Hex, timingSafeEqual, todayReminders,
} from '../../supabase/functions/device-api/logic.ts'
import { createSuite, runIfMain } from './helpers.mjs'

const U1 = '0b5f3c2e-9a1d-4c7e-8f00-1234567890ab'
const U2 = 'a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d'

const SUNDAY = 1
const TUESDAY = 1 << 2
const WEEKDAYS = 62
const EVERY_DAY = 127

export async function run() {
  const { check, results } = createSuite('device-api')
  console.log('\n--- device-api ---')

  // --- auth helpers -------------------------------------------------------
  // Same value as encode(digest('abc', 'sha256'), 'hex') in Postgres.
  check('1. sha256Hex matches the known digest of "abc"',
    (await sha256Hex('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  check('2. timingSafeEqual: equal', timingSafeEqual('abcd', 'abcd'))
  check('3. timingSafeEqual: different', !timingSafeEqual('abcd', 'abce'))
  check('4. timingSafeEqual: different length', !timingSafeEqual('abc', 'abcd'))
  check('5. isUuid accepts a v4 uuid', isUuid(U1))
  check('6. isUuid rejects junk', !isUuid('device-uuid-from-the-devices-table') && !isUuid(42))

  // --- parseEvent ---------------------------------------------------------
  {
    const e = parseEvent({ type: 'reminder', reminder_id: U1, reminder_slot_id: U2 })
    check('7. scheduled reminder keeps its slot id',
      typeof e === 'object' && e.reminder_slot_id === U2 && e.amount_ml === null)
  }
  {
    const e = parseEvent({ type: 'sip', reminder_id: U1, reminder_slot_id: U2, amount_ml: 149.6 })
    check('8. sip: amount rounded, slot id dropped (only reminders carry it)',
      typeof e === 'object' && e.amount_ml === 150 && e.reminder_slot_id === null)
  }
  check('9. sip without amount is rejected', typeof parseEvent({ type: 'sip' }) === 'string')
  check('10. unknown type is rejected', typeof parseEvent({ type: 'drink' }) === 'string')
  check('11. negative amount is rejected', typeof parseEvent({ type: 'sip', amount_ml: -5 }) === 'string')
  check('12. absurd amount is rejected', typeof parseEvent({ type: 'sip', amount_ml: 99999 }) === 'string')
  check('13. non-uuid reminder_id is rejected',
    typeof parseEvent({ type: 'completed', reminder_id: 'abc' }) === 'string')
  check('14. non-object body is rejected', typeof parseEvent(null) === 'string')
  {
    const e = parseEvent({ type: 'ignored', reminder_id: U1 })
    check('15. ignored with just a reminder_id is fine', typeof e === 'object' && e.reminder_id === U1)
  }

  // --- localClock ---------------------------------------------------------
  // Wednesday 2026-10-28 16:05 UTC = 12:05 EDT.
  {
    const c = localClock('America/New_York', new Date('2026-10-28T16:05:00Z'))
    check('16. New York afternoon', c.now === '12:05' && c.weekday === 3 && c.date === '2026-10-28', JSON.stringify(c))
  }
  // 03:30 UTC Wednesday is still Tuesday 23:30 in New York: the weekday must
  // follow the account's zone, not UTC.
  {
    const c = localClock('America/New_York', new Date('2026-10-28T03:30:00Z'))
    check('17. weekday and date follow the account zone',
      c.now === '23:30' && c.weekday === 2 && c.date === '2026-10-27', JSON.stringify(c))
  }
  {
    const c = localClock('America/New_York', new Date('2026-10-28T04:00:00Z'))
    check('18. local midnight is 00:00, not 24:00', c.now === '00:00' && c.weekday === 3, JSON.stringify(c))
  }
  {
    const c = localClock('Not/AZone', new Date('2026-10-28T16:05:00Z'))
    check('19. a bad timezone falls back to UTC', c.now === '16:05' && c.weekday === 3, JSON.stringify(c))
  }

  // --- todayReminders -----------------------------------------------------
  {
    const slots = [
      { id: 'c', time_of_day: '16:30:00', days_mask: EVERY_DAY, amount_ml: 200 },
      { id: 'a', time_of_day: '09:00:00', days_mask: WEEKDAYS, amount_ml: 150 },
      { id: 'b', time_of_day: '11:00:00', days_mask: SUNDAY, amount_ml: 100 },
      { id: 'd', time_of_day: '13:30:00', days_mask: TUESDAY, amount_ml: 250 },
    ]
    const tue = todayReminders(slots, 2)
    check('20. Tuesday: weekday + Tuesday + daily slots, in time order',
      tue.map((r) => r.id).join() === 'a,d,c', JSON.stringify(tue))
    check('21. times are trimmed to HH:MM', tue[0].time === '09:00' && tue[0].amount_ml === 150)
    const sun = todayReminders(slots, 0)
    check('22. Sunday: only Sunday + daily slots', sun.map((r) => r.id).join() === 'b,c')
  }

  return results()
}

runIfMain(import.meta.url, run)
