// Weekly reminder schedule: the reminder_slots table, its no-overlap rule,
// and who is allowed to read and write it.
//
// Test slots use times in the 03:00 hour, which nobody would schedule a real
// water reminder at, so a run can't collide with a schedule set up by hand.
// Everything created is deleted again at the end, pass or fail.

import { loadConfig, signIn, createSuite, runIfMain } from './helpers.mjs'

// Weekday bits: bit 0 = Sunday .. bit 6 = Saturday.
const EVERY_DAY = 127
const TUESDAY = 1 << 2        // 4
const SAT_SUN = (1 << 6) | 1  // 65
const MON_FRI = 2 | 4 | 8 | 16 | 32 // 62

export async function run() {
  const cfg = loadConfig()
  const { check, results } = createSuite('schedule')

  const main = await signIn(cfg, 'main account', cfg.accounts.main)
  const other = await signIn(cfg, 'caregiver', cfg.accounts.caregiver)

  console.log('\n--- schedule ---')

  // Start from a clean slate for the 03:00 hour, in case an earlier run died
  // partway and left rows behind.
  await clearTestSlots(main)
  // And make sure the second account starts unlinked.
  await other.client.rpc('stop_caring_for', { p_main: main.id })

  try {
    let dailyId = null

    // 1. Create a reminder on every day.
    {
      const { data, error } = await upsert(main, {
        time: '03:01', days: EVERY_DAY, amount: 150,
      })
      dailyId = data?.id ?? null
      check('1. create daily reminder', !error && !!data?.id, error?.message)
      check('1b. stored fields round-trip',
        data?.time_of_day?.startsWith('03:01') && data?.days_mask === EVERY_DAY && data?.amount_ml === 150,
        JSON.stringify(data))
    }

    // 2. Same time on a day the daily one already covers.
    {
      const { error } = await upsert(main, { time: '03:01', days: TUESDAY, amount: 150 })
      check('2. overlapping day+time rejected', !!error && /overlapping day/i.test(error.message),
        error ? error.message : 'was accepted')
    }

    // 3. Same time is fine when the day-sets are disjoint.
    {
      await del(main, dailyId)
      dailyId = null
      const a = await upsert(main, { time: '03:01', days: SAT_SUN, amount: 150 })
      const b = await upsert(main, { time: '03:01', days: MON_FRI, amount: 200 })
      check('3. same time on disjoint day-sets allowed', !a.error && !b.error,
        a.error?.message || b.error?.message)
      await del(main, a.data?.id)
      await del(main, b.data?.id)
    }

    // 4. Editing: into a conflict is rejected, into a free time is allowed.
    {
      const first = await upsert(main, { time: '03:10', days: EVERY_DAY, amount: 150 })
      const second = await upsert(main, { time: '03:20', days: EVERY_DAY, amount: 150 })

      const clash = await upsert(main, {
        id: second.data.id, time: '03:10', days: EVERY_DAY, amount: 150,
      })
      check('4a. edit into a conflict rejected', !!clash.error, clash.error ? '' : 'was accepted')

      const moved = await upsert(main, {
        id: second.data.id, time: '03:30', days: EVERY_DAY, amount: 175,
      })
      check('4b. edit to a free time allowed',
        !moved.error && moved.data?.time_of_day?.startsWith('03:30') && moved.data?.amount_ml === 175,
        moved.error?.message)
      check('4c. edit updated in place, no extra row', moved.data?.id === second.data.id)

      await del(main, first.data?.id)
      await del(main, second.data?.id)
    }

    // 5. A stranger can neither read nor write them.
    {
      const slot = await upsert(main, { time: '03:40', days: EVERY_DAY, amount: 150 })

      const { data: seen } = await other.client
        .from('reminder_slots').select('*').eq('main_id', main.id)
      check('5a. stranger cannot read', (seen ?? []).length === 0)

      const { error: writeErr } = await other.client.rpc('upsert_reminder_slot', {
        p_main: main.id, p_time: '03:41', p_days_mask: EVERY_DAY, p_amount_ml: 150, p_id: null,
      })
      check('5b. stranger cannot create', !!writeErr && /not allowed/i.test(writeErr.message),
        writeErr ? writeErr.message : 'was accepted')

      const { error: delErr } = await other.client.rpc('delete_reminder_slot', { p_id: slot.data.id })
      const { data: stillThere } = await main.client
        .from('reminder_slots').select('id').eq('id', slot.data.id).maybeSingle()
      check('5c. stranger cannot delete', !!delErr && stillThere !== null,
        delErr ? '' : 'delete was accepted')

      await del(main, slot.data?.id)
    }

    // 6. A caregiver can read and write them.
    {
      const slot = await upsert(main, { time: '03:50', days: EVERY_DAY, amount: 150 })
      await other.client.rpc('redeem_caregiver_code', { p_code: await codeOf(main) })

      const { data: seen } = await other.client
        .from('reminder_slots').select('*').eq('main_id', main.id)
      check('6a. caregiver can read', (seen ?? []).some((r) => r.id === slot.data.id))

      const edited = await upsert(other, {
        main: main.id, id: slot.data.id, time: '03:50', days: EVERY_DAY, amount: 250,
      })
      check('6b. caregiver can edit', !edited.error && edited.data?.amount_ml === 250, edited.error?.message)

      const created = await upsert(other, { main: main.id, time: '03:55', days: TUESDAY, amount: 100 })
      check('6c. caregiver can create', !created.error && !!created.data?.id, created.error?.message)

      const { error: cgDelErr } = await other.client
        .rpc('delete_reminder_slot', { p_id: created.data.id })
      check('6d. caregiver can delete', !cgDelErr, cgDelErr?.message)

      await del(main, slot.data?.id)
    }

    // 7. Deleting frees the time for reuse.
    {
      const a = await upsert(main, { time: '03:05', days: EVERY_DAY, amount: 150 })
      await del(main, a.data.id)
      const b = await upsert(main, { time: '03:05', days: EVERY_DAY, amount: 150 })
      check('7. deleted time can be reused', !b.error, b.error?.message)
      await del(main, b.data?.id)
    }

    // 8. Constraint checks.
    {
      const noDays = await upsert(main, { time: '03:06', days: 0, amount: 150 })
      check('8a. days_mask 0 rejected', !!noDays.error, noDays.error ? '' : 'was accepted')

      const zeroMl = await upsert(main, { time: '03:06', days: EVERY_DAY, amount: 0 })
      check('8b. amount_ml 0 rejected', !!zeroMl.error, zeroMl.error ? '' : 'was accepted')

      await del(main, noDays.data?.id)
      await del(main, zeroMl.data?.id)
    }
  } finally {
    await clearTestSlots(main)
    await other.client.rpc('stop_caring_for', { p_main: main.id })
    await main.client.auth.signOut()
    await other.client.auth.signOut()
  }

  return results()
}

// --- small wrappers --------------------------------------------------------

async function upsert(actor, { main, id = null, time, days, amount }) {
  return actor.client.rpc('upsert_reminder_slot', {
    p_main: main ?? actor.id,
    p_time: time,
    p_days_mask: days,
    p_amount_ml: amount,
    p_id: id,
  })
}

async function del(actor, id) {
  if (!id) return
  await actor.client.rpc('delete_reminder_slot', { p_id: id })
}

async function codeOf(actor) {
  const { data } = await actor.client
    .from('profiles').select('caregiver_code').eq('id', actor.id).single()
  return data.caregiver_code
}

// Remove anything this suite may have left in the 03:00 hour.
async function clearTestSlots(actor) {
  const { data } = await actor.client
    .from('reminder_slots').select('id, time_of_day').eq('main_id', actor.id)
  for (const row of data ?? []) {
    if (row.time_of_day?.startsWith('03:')) await del(actor, row.id)
  }
}

runIfMain(import.meta.url, run)
