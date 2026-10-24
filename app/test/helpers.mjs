// Shared plumbing for the integration tests.
//
// These run against the live Supabase project with real signed-in sessions, so
// they exercise row-level security the way the browser does. The Supabase MCP
// connection can't test RLS, because it runs as a privileged role that
// bypasses it.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

function parseEnv(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

export function bail(msg) {
  console.error('\n' + msg + '\n')
  process.exit(1)
}

export function loadConfig() {
  let env, accounts
  try {
    env = parseEnv(join(appRoot, '.env'))
  } catch {
    bail('Missing app/.env (need VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY).')
  }
  try {
    accounts = JSON.parse(readFileSync(join(here, 'accounts.json'), 'utf8'))
  } catch {
    bail('Missing app/test/accounts.json. Copy accounts.example.json and fill in passwords.')
  }
  const url = env.VITE_SUPABASE_URL
  const anonKey = env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) bail('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set in app/.env')
  if (/\/rest\/v1/.test(url)) {
    bail('VITE_SUPABASE_URL should be the bare project URL, with no /rest/v1 path.')
  }
  return { url, anonKey, accounts }
}

// Each client keeps its own in-memory session, so two accounts can be signed
// in at once and nothing is written to disk.
export async function signIn(cfg, label, creds) {
  const client = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client.auth.signInWithPassword({
    email: creds.email,
    password: creds.password,
  })
  if (error) bail(`Could not sign in ${label} (${creds.email}): ${error.message}`)
  const { data } = await client.auth.getUser()
  return { client, id: data.user.id }
}

export function createSuite(name) {
  const failures = []
  let passed = 0

  function check(label, cond, detail = '') {
    if (cond) {
      passed++
      console.log(`  ok   ${label}`)
    } else {
      failures.push(`${name}: ${label}`)
      console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
    }
  }

  return { check, results: () => ({ name, passed, failures }) }
}

// Lets a test file run on its own (`node test/schedule.test.mjs`) as well as
// being imported by run-all.mjs.
export function runIfMain(metaUrl, run) {
  if (process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href) {
    run().then((r) => process.exit(r.failures.length ? 1 : 0))
  }
}
