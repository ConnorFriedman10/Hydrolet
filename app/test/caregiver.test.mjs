// Integration test for the caregiver connection logic.
//
// Runs the plan's test sequence against the live Supabase project using two
// real signed-in sessions, so it actually exercises row-level security and the
// RPCs the way the browser does. (The Supabase MCP connection runs as a
// privileged role that bypasses RLS, so it cannot test this.)
//
// Setup:
//   1. cp app/test/accounts.example.json app/test/accounts.json
//   2. Fill in the two test accounts' passwords (file is gitignored).
//   3. From app/:  node test/caregiver.test.mjs
//
// It cleans up after itself: the caregiver link and any changed goal are
// restored at the end, pass or fail.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

// --- read config from app/.env and app/test/accounts.json ------------------

function parseEnv(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

let env, accounts
try {
  env = parseEnv(join(appRoot, '.env'))
} catch {
  fail('Missing app/.env (need VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY).')
}
try {
  accounts = JSON.parse(readFileSync(join(here, 'accounts.json'), 'utf8'))
} catch {
  fail('Missing app/test/accounts.json. Copy accounts.example.json and fill in passwords.')
}

const URL = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY
if (!URL || !ANON) fail('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set in app/.env')

// --- tiny test harness -----------------------------------------------------

let passed = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
function fail(msg) { console.error('\n' + msg + '\n'); process.exit(1) }

function clientFor() {
  // Independent in-memory session per client; nothing persisted to disk.
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function signIn(label, creds) {
  const c = clientFor()
  const { error } = await c.auth.signInWithPassword({ email: creds.email, password: creds.password })
  if (error) fail(`Could not sign in ${label} (${creds.email}): ${error.message}`)
  return c
}

// --- the run ---------------------------------------------------------------

const main = await signIn('main account', accounts.main)
const caregiver = await signIn('caregiver', accounts.caregiver)

const { data: mainMe } = await main.from('profiles').select('*').eq('id', (await main.auth.getUser()).data.user.id).single()
const { data: cgMe } = await caregiver.from('profiles').select('*').eq('id', (await caregiver.auth.getUser()).data.user.id).single()

const mainId = mainMe.id
const mainCode = mainMe.caregiver_code
const cgId = cgMe.id
const cgCode = cgMe.caregiver_code
const originalGoal = mainMe.daily_goal_ml

console.log(`\nmain:      ${mainMe.name} (${mainCode})`)
console.log(`caregiver: ${cgMe.name} (${cgCode})\n`)

// Start clean: make sure the caregiver is not already linked.
await caregiver.rpc('stop_caring_for', { p_main: mainId })

try {
  // 1. Both profiles exist with codes and names.
  check('1. both profiles readable with codes', !!mainCode && !!cgCode && !!mainMe.name && !!cgMe.name)

  // 8 (pre-link). Caregiver cannot read the main profile before linking.
  {
    const { data } = await caregiver.from('profiles').select('*').eq('id', mainId).maybeSingle()
    check('8. no access to main profile before linking', data === null)
  }

  // 2. Wrong code is rejected and changes nothing.
  {
    const { error } = await caregiver.rpc('redeem_caregiver_code', { p_code: 'XXXXXXXX' })
    const { data } = await caregiver.from('profiles').select('caretaker_of').eq('id', cgId).single()
    check('2. wrong code rejected, list unchanged',
      !!error && (data.caretaker_of ?? []).length === 0, error?.message)
  }

  // 3. Own code is rejected.
  {
    const { error } = await caregiver.rpc('redeem_caregiver_code', { p_code: cgCode })
    check('3. own code rejected', !!error && /your own caregiver/i.test(error.message), error?.message)
  }

  // 4. Redeeming the main account's code links them.
  {
    const { error } = await caregiver.rpc('redeem_caregiver_code', { p_code: mainCode })
    const { data } = await caregiver.from('profiles').select('caretaker_of').eq('id', cgId).single()
    check('4a. redeem succeeds', !error, error?.message)
    check('4b. caretaker_of contains main id', (data.caretaker_of ?? []).includes(mainId))
    const { data: mainProfile } = await caregiver.from('profiles').select('*').eq('id', mainId).maybeSingle()
    check('4c. caregiver can now read main profile', mainProfile !== null && mainProfile.id === mainId)
  }

  // 5. Redeeming again does not duplicate.
  {
    await caregiver.rpc('redeem_caregiver_code', { p_code: mainCode })
    const { data } = await caregiver.from('profiles').select('caretaker_of').eq('id', cgId).single()
    const count = (data.caretaker_of ?? []).filter((id) => id === mainId).length
    check('5. no duplicate after second redeem', count === 1)
  }

  // 6. Caregiver can edit the goal, but not the code.
  {
    const newGoal = originalGoal === 2000 ? 1800 : 2000
    const { error: editErr } = await caregiver.from('profiles')
      .update({ daily_goal_ml: newGoal }).eq('id', mainId)
    const { data: after } = await caregiver.from('profiles').select('daily_goal_ml').eq('id', mainId).single()
    check('6a. caregiver can edit goal', !editErr && after.daily_goal_ml === newGoal, editErr?.message)

    const { error: codeErr } = await caregiver.from('profiles')
      .update({ caregiver_code: 'HACKED00' }).eq('id', mainId)
    const { data: codeAfter } = await caregiver.from('profiles').select('caregiver_code').eq('id', mainId).single()
    check('6b. caregiver cannot change the code',
      (!!codeErr || codeAfter.caregiver_code === mainCode), codeErr ? '' : 'update silently applied')
  }

  // 7. Main removes the caregiver; access is lost.
  {
    const { error } = await main.rpc('remove_caregiver', { p_caregiver: cgId })
    check('7a. remove_caregiver succeeds', !error, error?.message)
    const { data } = await caregiver.from('profiles').select('caretaker_of').eq('id', cgId).single()
    check('7b. caretaker_of no longer contains main', !(data.caretaker_of ?? []).includes(mainId))
    const { data: mainProfile } = await caregiver.from('profiles').select('*').eq('id', mainId).maybeSingle()
    check('7c. caregiver loses read access to main', mainProfile === null)
  }
} finally {
  // Cleanup: unlink and restore the goal regardless of outcome.
  await caregiver.rpc('stop_caring_for', { p_main: mainId })
  await main.from('profiles').update({ daily_goal_ml: originalGoal }).eq('id', mainId)
  await main.auth.signOut()
  await caregiver.auth.signOut()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
