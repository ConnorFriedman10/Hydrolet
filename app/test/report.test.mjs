// Daily report: the sentences built from a report's facts (pure), then the
// live table and RPC: the person and linked caregivers can see and refresh a
// report, nobody else can, and clients cannot write one directly.
//
// The database part creates or updates today's report for the main test
// account. That is harmless (the nightly job rebuilds it) and is left in place.
// The caregiver's links are put back the way they were, pass or fail.

import { clock, describe, headline, volume } from '../src/lib/report.ts'
import { loadConfig, signIn, createSuite, runIfMain } from './helpers.mjs'

const PRONOUNS = /\b(she|her|hers|herself|he|him|his|himself|they|them|their|you|your)\b/i

/** A full facts object with sensible defaults, overridable per test. */
function facts(over = {}) {
  return {
    date: '2026-10-24',
    day_complete: true,
    goal_ml: 1500,
    planned_ml: 1200,
    total_ml: 900,
    reminders: { sent: 4, completed: 3, ignored: 1, open: 0, unscheduled: 0, missed: 0 },
    sips: { count: 9, average_ml: 100, largest_ml: 180 },
    first_sip_median_min: 1.6,
    complete_median_min: 6.2,
    periods: [
      { name: 'morning', planned_ml: 600, drank_ml: 600, sent: 2, ignored: 0 },
      { name: 'afternoon', planned_ml: 400, drank_ml: 100, sent: 1, ignored: 1 },
      { name: 'evening', planned_ml: 200, drank_ml: 200, sent: 1, ignored: 0 },
    ],
    week: { days: 6, average_ml: 700, goal_met_days: 2 },
    firings: [],
    ...over,
  }
}

export async function run() {
  const { check, results } = createSuite('report')
  console.log('\n--- report ---')

  // --- sentences (pure) ---------------------------------------------------
  {
    const r = facts()
    const lines = describe(r)
    const all = [headline(r), ...lines].join(' ')
    check('1. headline: total and share of plan',
      headline(r) === '900 mL drunk during reminders, 75% of the 1.2 L planned.', headline(r))
    check('2. reminder outcomes', lines.includes('3 of 4 reminders were finished and 1 was ignored.'), lines[0])
    check('3. first-sip timing', lines.some((l) => l.includes('first sip usually came within about 2 minutes')))
    check('4. best part of the day', lines.includes('Most water was drunk in the morning (600 mL).'))
    check('5. weakest part, against its own plan',
      lines.includes('The afternoon fell furthest behind: 100 mL of 400 mL planned.'))
    check('6. sips', lines.includes('9 sips of about 100 mL each; the largest was 180 mL.'))
    check('7. week comparison', lines.includes('200 mL more than the previous 6 days with reminders (average 700 mL).'))
    check('8. goal days', lines.includes('The daily goal was reached on 2 of those 6 days.'))
    check('9. no pronouns anywhere', !PRONOUNS.test(all), all.match(PRONOUNS)?.[0])
    check('10. no advice words', !/\b(should|must|try to|recommend|drink more)\b/i.test(all))
  }
  {
    const r = facts({ reminders: { sent: 3, completed: 3, ignored: 0, open: 0, unscheduled: 1, missed: 1 } })
    const lines = describe(r)
    check('11. all finished', lines.includes('All 3 reminders were finished.'), lines[0])
    check('12. missed and extra reminders',
      lines.some((l) => l.startsWith("1 scheduled reminder didn't go off"))
      && lines.includes('1 extra reminder was sent from the app.'))
  }
  {
    const r = facts({
      day_complete: false,
      reminders: { sent: 2, completed: 1, ignored: 0, open: 1, unscheduled: 0, missed: 0 },
    })
    check('13. today: an open reminder is "still in progress"',
      describe(r)[0] === '1 of 2 reminders was finished and 1 was still in progress.', describe(r)[0])
  }
  {
    const r = facts({
      total_ml: 0, planned_ml: 0, first_sip_median_min: null, complete_median_min: null,
      reminders: { sent: 0, completed: 0, ignored: 0, open: 0, unscheduled: 0, missed: 0 },
      sips: { count: 0, average_ml: null, largest_ml: null },
      week: { days: 0, average_ml: null, goal_met_days: 0 },
    })
    check('14. an empty day says so, with no pattern lines',
      describe(r).length === 0 && headline(r).startsWith('Nothing was scheduled'), headline(r))
  }
  {
    const r = facts({ week: { days: 3, average_ml: 880, goal_met_days: 0 } })
    check('15. close to the usual amount', describe(r).some((l) => l.startsWith('About the same as the previous 3 days')))
  }
  check('15b. a fast first sip reads naturally',
    describe(facts({ first_sip_median_min: 0.7 })).includes('After a reminder, the first sip usually came in under a minute.'))
  check('16. helpers', volume(1250) === '1.3 L' && volume(95) === '95 mL'
    && clock('16:23') === '4:23 PM' && clock('00:05') === '12:05 AM')

  // --- live table and RPC -------------------------------------------------
  const cfg = loadConfig()
  const main = await signIn(cfg, 'main account', cfg.accounts.main)
  const carer = await signIn(cfg, 'caregiver', cfg.accounts.caregiver)

  const { data: before } = await carer.client.from('profiles').select('caretaker_of').eq('id', carer.id).single()
  const wasLinked = (before?.caretaker_of ?? []).includes(main.id)
  const { data: mainProfile } = await main.client.from('profiles').select('caregiver_code').eq('id', main.id).single()

  try {
    await carer.client.rpc('stop_caring_for', { p_main: main.id })

    let today = null
    {
      const { data, error } = await main.client.rpc('refresh_daily_report', { p_main: main.id })
      today = data?.date ?? null
      check('17. the person can create their own report',
        !error && data?.main_id === main.id && typeof data?.report?.total_ml === 'number', error?.message)
    }
    {
      const { data } = await main.client.from('daily_reports').select('*').eq('main_id', main.id).eq('date', today)
      check('18. and read it back', data?.length === 1)
    }
    {
      const { data } = await carer.client.from('daily_reports').select('*').eq('main_id', main.id)
      const { error } = await carer.client.rpc('refresh_daily_report', { p_main: main.id })
      check('19. a stranger sees no reports and cannot create one',
        (data ?? []).length === 0 && /not allowed/i.test(error?.message ?? ''), error?.message)
    }

    await carer.client.rpc('redeem_caregiver_code', { p_code: mainProfile.caregiver_code })
    {
      const { data } = await carer.client.from('daily_reports').select('*').eq('main_id', main.id).eq('date', today)
      const { error } = await carer.client.rpc('refresh_daily_report', { p_main: main.id, p_date: today })
      check('20. a linked caregiver sees the same report and can update it',
        data?.length === 1 && !error, error?.message)
    }
    {
      const { error } = await main.client.from('daily_reports')
        .insert({ main_id: main.id, date: '2000-01-01', report: {} })
      check('21. clients cannot write reports directly', !!error, 'insert was allowed')
    }
    {
      const { error } = await main.client.rpc('refresh_daily_report', { p_main: main.id, p_date: '2999-01-01' })
      check('22. a future day is refused', /not happened yet/i.test(error?.message ?? ''), error?.message)
    }
    {
      const { data } = await main.client.from('daily_reports').select('report').eq('main_id', main.id).eq('date', today).single()
      const r = data?.report
      const ok = r && ['sent', 'completed', 'ignored', 'open', 'unscheduled', 'missed']
        .every((k) => typeof r.reminders?.[k] === 'number')
        && Array.isArray(r.periods) && r.periods.length === 3 && Array.isArray(r.firings)
      check('23. stored facts have the shape the app reads', !!ok)
      if (r) {
        const lines = [headline(r), ...describe(r)]
        check('24. the real report turns into sentences', lines.length >= 1 && !PRONOUNS.test(lines.join(' ')))
        console.log('       ' + lines.join('\n       '))
      }
    }
  } finally {
    await carer.client.rpc('stop_caring_for', { p_main: main.id })
    if (wasLinked) await carer.client.rpc('redeem_caregiver_code', { p_code: mainProfile.caregiver_code })
  }

  return results()
}

runIfMain(import.meta.url, run)
