# Running Hydrolet on localhost

The backend (database, Edge Functions, scheduled pushes) already runs on the hosted Supabase project. Running Hydrolet locally means running the caregiver app on your computer against that project. You don't need a local database.

Commands below are for PowerShell on Windows. On macOS or Linux, use `cp` instead of `Copy-Item`.

## What you need

- **Node.js 22.6 or newer** (the tests rely on `--experimental-strip-types`). Check with `node --version`.
- **Git**, to clone the repo.
- **PlatformIO**, only if you're flashing the coaster or band.

## 1. Install the app

```powershell
git clone <repo-url>
cd Hydrolet\app
npm install
```

## 2. Create `app/.env`

```powershell
Copy-Item .env.example .env
```

Fill in the three values. `.env` is gitignored, so it never gets committed.

| Variable | Where to find it |
|---|---|
| `VITE_SUPABASE_URL` | Supabase dashboard → Project Settings → API. Use the bare project URL, with no `/rest/v1` on the end. |
| `VITE_SUPABASE_ANON_KEY` | Same page: the publishable (anon) key. Never the service role key. |
| `VITE_VAPID_PUBLIC_KEY` | Ask the app lead. It must match the `VAPID_PUBLIC_KEY` secret set on Supabase, or notifications will fail. |

## 3. Start it

```powershell
npm run dev
```

Open the address it prints, normally http://localhost:5173. If you change `.env` later, stop the server (Ctrl+C) and start it again, because Vite only reads `.env` at startup.

## 4. First run

1. **Create an account** on the login page.
2. **Schedule page:** set the daily goal and add a few reminders.
3. **Family page:** tap "Enable notifications". Push works on localhost in Chrome, Edge and Firefox, and a test notification should arrive.
4. **Hidden `/dev` page** (http://localhost:5173/dev): register a coaster to get its device id and secret, and fake reminders and sips without any hardware.

## Phones

`localhost` only works on the computer running the server. Opening the app from a phone at your computer's network address (for example `http://192.168.x.x:5173`) isn't HTTPS, so the phone can't install the app or receive notifications. Phones need the app deployed (for example to Vercel) or served through an HTTPS tunnel.

## Tests and build

```powershell
npm run test:timeline    # pure logic, no network
npm run test:send-push   # pure logic, no network
npm test                 # everything, including the database suites
npm run build            # type-check and production build
```

`npm test` signs in as two real test accounts. Copy `test/accounts.example.json` to `test/accounts.json` and fill in their passwords first (`accounts.json` is gitignored). See [app/test/README.md](../app/test/README.md).

## Changing the backend (only if you edit `supabase/`)

The app doesn't need any of this to run. These commands deploy to the live project, so check with the app lead first.

```powershell
npx supabase login
npx supabase link --project-ref <project-ref>   # the subdomain of VITE_SUPABASE_URL
npx supabase db push --linked                   # apply new files in supabase/migrations
npx supabase functions deploy send-push --no-verify-jwt
npx supabase functions deploy device-api --no-verify-jwt
```

- Both functions check every request themselves, so JWT verification stays off. `supabase/config.toml` keeps it that way.
- Name new migrations with the current date and time (`YYYYMMDDHHMMSS_name.sql`). Two migrations with the same number will fail to apply.

## Hardware

**Coaster** (Seeed XIAO ESP32-C3):

```powershell
cd coaster
Copy-Item src\secrets.example.h src\secrets.h   # then fill it in
pio run -t upload
pio device monitor
```

- `secrets.h` needs **2.4 GHz** Wi-Fi details (a phone hotspot is safest) and the coaster's device id and secret from the `/dev` page. The secret is shown only once.
- After the first flash, calibrate the scale in the monitor. [coaster/README.md](../coaster/README.md) has the steps and every serial command.
- If the upload can't connect: hold BOOT, tap RESET, release BOOT, upload again, then tap RESET.

**Band** (Seeed XIAO nRF52840 Sense):

```powershell
cd band-firmware
pio run -t upload
```

## If something's wrong

- **"Supabase isn't configured"**: `app/.env` is missing or incomplete, or the dev server was started before you filled it in. Fix it and restart.
- **"Enable notifications" fails, or no test notification arrives**: check that `VITE_VAPID_PUBLIC_KEY` matches the key on Supabase, and that the browser hasn't blocked notifications for the site.
- **The dashboard says the coaster is offline**: check the coaster's serial monitor. The usual causes are a 5 GHz network or a wrong device secret (`[API]` lines show a 401).
- **Port 5173 is already in use**: Vite picks the next free port and prints it, so use that address.
