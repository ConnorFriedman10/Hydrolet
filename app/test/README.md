# Tests

```
npm test               # everything
npm run test:timeline  # pure logic, no database, instant
npm run test:caregiver
npm run test:schedule
npm run test:events
```

## Setup (once)

The two database suites sign in as real accounts, so they need passwords:

1. `cp test/accounts.example.json test/accounts.json` and fill in the two test
   accounts' passwords. `accounts.json` is gitignored.
2. Make sure `app/.env` has `VITE_SUPABASE_URL` (the bare project URL, with no
   `/rest/v1` path) and `VITE_SUPABASE_ANON_KEY`.

## The suites

**`timeline.test.mjs`** — pure logic, no network. Checks how a scheduled slot
plus the events it produced turn into a status: upcoming, drinking now, done,
ignored, or never sent. Also covers slots on other weekdays being excluded,
unscheduled "remind her now" firings, sips not leaking between firings, and
ordering. Node runs the TypeScript source directly via `--experimental-strip-types`.

**`send-push.test.mjs`** — pure logic, no network. Request parsing, the
conversion of base64url VAPID keys to the JWKs the Deno webpush library needs
(round-tripped through WebCrypto), a check that `VITE_VAPID_PUBLIC_KEY` in
`app/.env` is a valid key, and the notification text.

**`caregiver.test.mjs`** — redeeming a caregiver code, what that grants, and
removing it again.

**`schedule.test.mjs`** — the `reminder_slots` table, its no-overlap rule
(same time is fine on disjoint day-sets, rejected when the day-sets touch),
editing, deleting, and who may read and write.

**`events.test.mjs`** — the dev-only insert and delete policies on `events`,
which let the /dev page fake coaster traffic and reset between runs. These
widen what a signed-in client may do, so the suite pins the boundary: an
account and its caregivers can write and erase its events, a stranger cannot.

The two database suites run against the live project with two real signed-in
sessions, so they exercise row-level security the way the browser does — the
Supabase MCP connection can't, because it runs as a privileged role that
bypasses RLS.

Both clean up after themselves, pass or fail: the caregiver link and daily goal
are restored, and the schedule suite only touches times in the 03:00 hour
(which nobody would schedule a real reminder at) and deletes them again.
