// Caregiver connection: redeeming codes, what that grants, and removing it
// again. Restores the link state and the daily goal afterward, pass or fail,
// so it is safe to run repeatedly.

import { loadConfig, signIn, createSuite, runIfMain } from './helpers.mjs'

export async function run() {
  const cfg = loadConfig()
  const { check, results } = createSuite('caregiver')

  const main = await signIn(cfg, 'main account', cfg.accounts.main)
  const caregiver = await signIn(cfg, 'caregiver', cfg.accounts.caregiver)

  const { data: mainMe } = await main.client
    .from('profiles').select('*').eq('id', main.id).single()
  const { data: cgMe } = await caregiver.client
    .from('profiles').select('*').eq('id', caregiver.id).single()

  const mainCode = mainMe.caregiver_code
  const cgCode = cgMe.caregiver_code
  const originalGoal = mainMe.daily_goal_ml

  console.log('\n--- caregiver ---')
  console.log(`  main: ${mainMe.name} (${mainCode}), caregiver: ${cgMe.name} (${cgCode})`)

  // Start unlinked, in case an earlier run died partway.
  await caregiver.client.rpc('stop_caring_for', { p_main: main.id })

  try {
    check('1. both profiles readable with codes',
      !!mainCode && !!cgCode && !!mainMe.name && !!cgMe.name)

    // No access before linking.
    {
      const { data } = await caregiver.client
        .from('profiles').select('*').eq('id', main.id).maybeSingle()
      check('2. no access to main profile before linking', data === null)
    }

    // Wrong code changes nothing.
    {
      const { error } = await caregiver.client
        .rpc('redeem_caregiver_code', { p_code: 'XXXXXXXX' })
      const { data } = await caregiver.client
        .from('profiles').select('caretaker_of').eq('id', caregiver.id).single()
      check('3. wrong code rejected, list unchanged',
        !!error && (data.caretaker_of ?? []).length === 0, error?.message)
    }

    // Own code rejected.
    {
      const { error } = await caregiver.client.rpc('redeem_caregiver_code', { p_code: cgCode })
      check('4. own code rejected', !!error && /your own caregiver/i.test(error.message),
        error?.message)
    }

    // Redeeming links them.
    {
      const { error } = await caregiver.client.rpc('redeem_caregiver_code', { p_code: mainCode })
      const { data } = await caregiver.client
        .from('profiles').select('caretaker_of').eq('id', caregiver.id).single()
      check('5a. redeem succeeds', !error, error?.message)
      check('5b. caretaker_of contains main id', (data.caretaker_of ?? []).includes(main.id))

      const { data: mainProfile } = await caregiver.client
        .from('profiles').select('*').eq('id', main.id).maybeSingle()
      check('5c. caregiver can now read main profile', mainProfile?.id === main.id)
    }

    // Redeeming twice does not duplicate.
    {
      await caregiver.client.rpc('redeem_caregiver_code', { p_code: mainCode })
      const { data } = await caregiver.client
        .from('profiles').select('caretaker_of').eq('id', caregiver.id).single()
      const count = (data.caretaker_of ?? []).filter((id) => id === main.id).length
      check('6. no duplicate after second redeem', count === 1)
    }

    // Can edit the goal, cannot touch the code.
    {
      const newGoal = originalGoal === 2000 ? 1800 : 2000
      const { error: editErr } = await caregiver.client
        .from('profiles').update({ daily_goal_ml: newGoal }).eq('id', main.id)
      const { data: after } = await caregiver.client
        .from('profiles').select('daily_goal_ml').eq('id', main.id).single()
      check('7a. caregiver can edit goal',
        !editErr && after.daily_goal_ml === newGoal, editErr?.message)

      const { error: codeErr } = await caregiver.client
        .from('profiles').update({ caregiver_code: 'HACKED00' }).eq('id', main.id)
      const { data: codeAfter } = await caregiver.client
        .from('profiles').select('caregiver_code').eq('id', main.id).single()
      check('7b. caregiver cannot change the code',
        !!codeErr || codeAfter.caregiver_code === mainCode,
        codeErr ? '' : 'update silently applied')
    }

    // The app fetches profiles with no filter and lets the select policy do
    // the scoping, which is what collapses two round trips into one. If that
    // policy ever widened, this would catch it.
    {
      const { data: theirs } = await caregiver.client.from('profiles').select('id')
      const ids = (theirs ?? []).map((p) => p.id).sort()
      check('9a. caregiver sees exactly themselves and the account they care for',
        JSON.stringify(ids) === JSON.stringify([caregiver.id, main.id].sort()),
        `${ids.length} rows`)

      const { data: mine } = await main.client.from('profiles').select('id')
      const mineIds = (mine ?? []).map((p) => p.id).sort()
      check('9b. main sees exactly themselves and their caregiver',
        JSON.stringify(mineIds) === JSON.stringify([caregiver.id, main.id].sort()),
        `${mineIds.length} rows`)
    }

    // Removal revokes access.
    {
      const { error } = await main.client.rpc('remove_caregiver', { p_caregiver: caregiver.id })
      check('8a. remove_caregiver succeeds', !error, error?.message)

      const { data } = await caregiver.client
        .from('profiles').select('caretaker_of').eq('id', caregiver.id).single()
      check('8b. caretaker_of no longer contains main', !(data.caretaker_of ?? []).includes(main.id))

      const { data: mainProfile } = await caregiver.client
        .from('profiles').select('*').eq('id', main.id).maybeSingle()
      check('8c. caregiver loses read access to main', mainProfile === null)

      const { data: visible } = await caregiver.client.from('profiles').select('id')
      check('8d. unfiltered select narrows back to just themselves',
        (visible ?? []).length === 1 && visible[0].id === caregiver.id,
        `${(visible ?? []).length} rows`)
    }
  } finally {
    await caregiver.client.rpc('stop_caring_for', { p_main: main.id })
    await main.client.from('profiles').update({ daily_goal_ml: originalGoal }).eq('id', main.id)
    await main.client.auth.signOut()
    await caregiver.client.auth.signOut()
  }

  return results()
}

runIfMain(import.meta.url, run)
