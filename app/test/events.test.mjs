// The dev-only insert and delete policies on `events`.
//
// These exist so the hidden /dev page can fake what the coaster will send and
// reset between demo runs. They widen what a signed-in client may do, so the
// boundary matters: an account and its caregivers, and nobody else.

import { loadConfig, signIn, createSuite, runIfMain } from './helpers.mjs'

export async function run() {
  const cfg = loadConfig()
  const { check, results } = createSuite('events')

  const main = await signIn(cfg, 'main account', cfg.accounts.main)
  const other = await signIn(cfg, 'caregiver', cfg.accounts.caregiver)

  console.log('\n--- events ---')

  await other.client.rpc('stop_caring_for', { p_main: main.id })

  const created = []
  const add = async (actor, mainId, row) => {
    const { data, error } = await actor.client
      .from('events').insert({ main_id: mainId, ...row }).select().maybeSingle()
    if (data) created.push(data.id)
    return { data, error }
  }

  try {
    // Own events: insert and delete.
    {
      const { data, error } = await add(main, main.id, { type: 'sip', amount_ml: 1 })
      check('1a. owner can insert', !error && !!data, error?.message)

      const { error: delErr } = await main.client.from('events').delete().eq('id', data.id)
      const { data: gone } = await main.client
        .from('events').select('id').eq('id', data.id).maybeSingle()
      check('1b. owner can delete', !delErr && gone === null, delErr?.message)
    }

    // A stranger can neither write nor erase someone else's history.
    {
      const { data: mine } = await add(main, main.id, { type: 'sip', amount_ml: 2 })

      const { error: insErr } = await add(other, main.id, { type: 'sip', amount_ml: 999 })
      check('2a. stranger cannot insert', !!insErr, insErr ? '' : 'was accepted')

      await other.client.from('events').delete().eq('id', mine.id)
      const { data: survived } = await main.client
        .from('events').select('id').eq('id', mine.id).maybeSingle()
      check('2b. stranger cannot delete', survived !== null, 'row was erased')
    }

    // A caregiver can do both, on the account they care for.
    {
      const { data: code } = await main.client
        .from('profiles').select('caregiver_code').eq('id', main.id).single()
      await other.client.rpc('redeem_caregiver_code', { p_code: code.caregiver_code })

      const { data, error } = await add(other, main.id, { type: 'sip', amount_ml: 3 })
      check('3a. caregiver can insert', !error && !!data, error?.message)

      await other.client.from('events').delete().eq('id', data.id)
      const { data: gone } = await main.client
        .from('events').select('id').eq('id', data.id).maybeSingle()
      check('3b. caregiver can delete', gone === null)
    }
  } finally {
    for (const id of created) await main.client.from('events').delete().eq('id', id)
    await other.client.rpc('stop_caring_for', { p_main: main.id })
    await main.client.auth.signOut()
    await other.client.auth.signOut()
  }

  return results()
}

runIfMain(import.meta.url, run)
