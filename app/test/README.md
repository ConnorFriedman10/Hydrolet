# Tests

## Caregiver integration test

`caregiver.test.mjs` runs the auth plan's test sequence against the live Supabase
project with two real signed-in sessions, so it actually exercises row-level
security and the caregiver RPCs (the Supabase MCP connection can't, because it
runs as a privileged role that bypasses RLS).

### Run it

1. Copy the credentials template and fill in the two test accounts' passwords:
   ```
   cp test/accounts.example.json test/accounts.json
   ```
   `accounts.json` is gitignored. The default emails are the Connor (main) and
   Henry (caregiver) test accounts.
2. Make sure `app/.env` has `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. From `app/`:
   ```
   npm run test:caregiver
   ```

### What it covers

- Both profiles are readable, with codes and names.
- A caregiver has no access to the main profile before linking.
- Wrong code rejected; own code rejected ("your own caregiver").
- Redeeming the code links them and grants read access.
- Redeeming twice does not duplicate the link.
- A caregiver can edit the goal but cannot change the caregiver code.
- Removing the caregiver revokes access.

It restores the link state and the daily goal afterward, pass or fail, so it's
safe to run repeatedly.
