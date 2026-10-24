# Accounts, login, and caretaker connection: implementation plan

Scope: sign up, log in, log out, session handling, caretaker codes, and switching between accounts you care for. Not in scope: push notifications, the dashboard contents, the schedule editor (those pages only need to receive "which account am I viewing").

## Current state

**Database (already applied to the Supabase project):**
- A trigger on `auth.users` creates a `profiles` row on signup. It reads the name from `raw_user_meta_data ->> 'name'`, so the app must pass `options.data.name` to `signUp`.
- Every profile gets a unique 8-character `caregiver_code` automatically.
- `profiles.caretaker_of uuid[]` is the list of accounts this user takes care of. Clients cannot write it directly; it only changes through RPCs:
  - `redeem_caregiver_code(p_code)` returns the main account's id. Errors: `Not signed in`, `Invalid caregiver code`, `You cannot be your own caregiver`. Redeeming twice is a no-op.
  - `remove_caregiver(p_caregiver)`: a main account removes someone who cares for them.
  - `stop_caring_for(p_main)`: a caregiver leaves an account.
  - `regenerate_caregiver_code()` returns the new code.
- Row-level security: `has_access(id)` is true for your own id or any id in your `caretaker_of`. You can read your own profile, profiles you care for, and profiles of people who list you in their `caretaker_of` (so a main account can show its caregiver names). Caregivers can update `name`, `daily_goal_ml`, `schedule`, `timezone` on accounts they care for; `caregiver_code`, `caretaker_of`, and `id` are not updatable.

**App (`app/`):** a skeleton with placeholder pages. There is no auth, no session handling, and no route guard. `src/lib/supabase.ts` exports `supabase` (null until `app/.env` has the URL and anon key) and `isConfigured`. `src/lib/types.ts` has the `Profile` type including `caretaker_of`.

**Warning about the old code:** an earlier, fuller version of the app is in the scratchpad backup (`...\scratchpad\full-app-backup`). Its `auth.tsx` and `Caregivers.tsx` query the deleted `caregiver_links` table. Reuse the structure, but rewrite those queries (see "Subjects" below).

## The model, in plain terms

Every account is the same kind of account. There is no "main" or "caregiver" role stored anywhere. A person is a caregiver of another account if that account's id is in their `caretaker_of`. The same person can be both: the main account for their own devices, and a caretaker of others.

The grandparent's account is usually created by a family member on their behalf (per the product plan).

## Flows

### Sign up
1. Login page, "Create an account" mode: name, email, password (min 6 characters).
2. `supabase.auth.signUp({ email, password, options: { data: { name } } })`.
3. If email confirmation is **off** (recommended for the hackathon, see Supabase settings), the call returns a session and the user lands on the dashboard. If it is on, show "Check your email to confirm" and stop.
4. The trigger has already created the profile by the time the session exists, so the first profile fetch will succeed. No client-side profile insert.

### Log in / out
- `signInWithPassword`; errors shown inline in plain language ("Wrong email or password").
- `signOut` from the nav. On sign out, clear the remembered "viewing" account from `localStorage`.
- Supabase persists the session in `localStorage` and refreshes tokens automatically, so a returning user opens the app already logged in.

### Session gate
- `AuthProvider` holds `{ session, loading }` from `getSession()` and `onAuthStateChange`.
- While `loading`, show a blank or "Loading" state (never flash the login page to a logged-in user).
- No session: render only the Login page. Session: render the routes. Do not use a redirect loop; a simple conditional in `App.tsx` is enough.
- If `isConfigured` is false (no keys), show a small "Supabase isn't configured" message instead of crashing.

### Setting up a family member's account (the main use case)
Done on the family member's phone, in two steps. Say this plainly in the UI:
1. Create the grandparent's account (their email and password) and note their caregiver code on the Family page.
2. Log out, create the family member's own account, and on the Family page enter the grandparent's code under "Care for someone else".

**Stretch goal, not in this build's scope:** a "create an account for someone else" flow that lets a caregiver set up the grandparent's account without logging out of their own session first. This needs a server-side function with the service role key (the client can't create another user's auth account while staying signed in as itself). Do not build this now; the two-step flow above is the baseline.

### Becoming a caretaker
1. Family page, "Care for someone else": text box, uppercase automatically, 8 characters, Add button disabled until 8 characters.
2. Call `supabase.rpc('redeem_caregiver_code', { p_code })`.
3. On success: reload subjects so the new account appears in the switcher, and show "Added" with their name.
4. On error: show the RPC's message. Map `Invalid caregiver code` to "That code isn't valid. Check it and try again."

### Subjects: which account am I viewing?
- `SubjectProvider` exposes `subjects` (me first, then accounts I care for), `subject` (the one selected), `me`, `select(id)`, and `reload()`.
- Load order: fetch my own profile by `session.user.id`, then fetch `profiles` where `id in (myId, ...me.caretaker_of)`. One round trip fewer than the old links approach.
- The selected id is remembered in `localStorage` (wrapped in try/catch). If it is no longer in the list, fall back to `me`.
- The header shows a dropdown only when there is more than one subject. Pages read `subject` and never touch the session directly.

### Managing relationships (Family page)
- **My code:** show `me.caregiver_code` large, with a "Make a new code" button (`regenerate_caregiver_code`, confirm first, then `reload()`).
- **My caregivers:** `select id, name from profiles where caretaker_of @> array[me.id]` (supabase-js: `.contains('caretaker_of', [me.id])`). Remove button calls `remove_caregiver`.
- **People I care for:** list from `subjects` minus me. "Stop caring" calls `stop_caring_for`, then `reload()`.

## Supabase dashboard settings (manual, one-time)

1. **Authentication, Providers, Email:** confirm email is already **off** (done), so signup returns a session immediately. This is a hackathon shortcut; turn it back on before real use.
2. **Authentication, URL Configuration:** set the Site URL to the deployed app URL once it exists (and add `http://localhost:5173` as an additional redirect URL).
3. Keep password minimum at 6 (the Supabase default).

## Files to build or change

| File | Change |
|---|---|
| `app/src/lib/auth.tsx` | New: `AuthProvider`, `useAuth`, `SubjectProvider`, `useSubject` (as above) |
| `app/src/main.tsx` | Wrap `<App />` in `AuthProvider` and `SubjectProvider` |
| `app/src/App.tsx` | Session gate: loading, then Login or routes |
| `app/src/pages/Login.tsx` | Real login and signup form |
| `app/src/pages/Caregivers.tsx` | Code, caregivers list, redeem box, people I care for |
| `app/src/components/Layout.tsx` | Account switcher, log out button |
| `app/.env` | Not committed. `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |

Dashboard, Schedule, Summary, Install, Dev stay as placeholders except that they may read `subject`.

## Testing

Two real accounts already exist for this: **Connor** (code `7YFYMWUR`, plays the "grandparent"/main account) and **Henry** (plays the family member/caregiver). With the Supabase MCP connected (read-only), verify with SQL after each step; actions themselves are done in the app.

1. Both accounts exist. Check `profiles` has two rows with different codes and the right names.
2. Henry enters a wrong code: error shown, `caretaker_of` unchanged.
3. Henry enters his own code: "cannot be your own caregiver".
4. Henry enters Connor's code (`7YFYMWUR`): Henry's `caretaker_of` contains Connor's id; Henry's switcher shows Connor; Henry sees Connor's profile and (later) events.
5. Henry enters Connor's code again: no duplicate in the array.
6. Henry edits Connor's goal: works. Henry tries to change Connor's `caregiver_code` directly via the client: rejected.
7. Connor's Family page lists Henry as a caregiver. Connor removes Henry: Henry loses access (switcher no longer shows Connor, profile fetch for Connor returns nothing).
8. A third account who never entered a code cannot read Connor's profile.
9. Refresh the page while logged in: stays logged in. Log out: back to Login, remembered subject cleared.
10. `npm run build` passes (it type-checks).

## Known gaps and open questions

- **Code guessing:** codes are 8 characters from a 32-letter alphabet (about 1.1 trillion combinations), so guessing is impractical, but there is no rate limit on `redeem_caregiver_code`. Fine for the hackathon; note it.
- **A caregiver can edit the goal and schedule** (intended per the plan, since the doctor-set goal is confirmed by a caregiver). Caregivers cannot see or change the main account's password or email.
- **Anyone with a code gets full caretaker access.** The "regenerate code" button is the revoke mechanism for codes shared too widely; removing a caregiver does not change the code.
- **No password reset flow** is planned. Supabase supports it; add later if wanted.
- **Separate editor/viewer roles** are a plan stretch goal and would need `caretaker_of` to become a table or a jsonb map. Not needed now.

## What the implementer needs from the user

1. The project URL (`https://nfgmrapqkujdcbokmdul.supabase.co`) and the **publishable (anon) key**, put in `app/.env`. Never the service role key.
2. Confirm email confirmation is switched off in the dashboard (or accept that signup will require checking email).
3. Two throwaway test accounts to use for the tests above (the one existing account can be A).
