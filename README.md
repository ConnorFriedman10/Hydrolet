# Hydrolet

A hydration reminder for people with dementia and memory loss. A watch buzzes when it's time to drink, a coaster under her own cup measures how much she drinks, and a caregiver app keeps family informed.

```
Caregiver app  ⇄  Supabase (cloud)  ⇄  Coaster (Wi-Fi + BLE)  ⇄  Watch (BLE only)
```

The full plan is in [docs/hydrolet-plan.md](docs/hydrolet-plan.md).

## Layout

| Folder | What's in it | Owner |
|---|---|---|
| `app/` | React + Vite PWA | App lead |
| `supabase/` | Migrations and Edge Functions (`device-api`, `send-push`) | App lead |
| `coaster/` | PlatformIO firmware for the coaster | Hardware lead |
| `band-firmware/` | PlatformIO firmware for the watch (band) | Hardware lead |
| `shared/` | `ble_protocol.h`, used by both firmware projects | Both |
| `docs/` | The plan and design mockups | Both |
| `.kiro/` | Steering files and specs that Kiro reads | Both |

The contracts both halves depend on (tables, device API, BLE) are in [.kiro/steering/contracts.md](.kiro/steering/contracts.md). Tell the other person before changing one.

## Running each part

Full steps, including first-run setup, tests and troubleshooting, are in [docs/run-locally.md](docs/run-locally.md). The short version:

**App**

```
cd app
cp .env.example .env     # fill in the Supabase URL, anon key and VAPID public key
npm install
npm run dev              # http://localhost:5173
```

**Database**: already hosted on Supabase. Only if you change `supabase/`: `npx supabase db push --linked`.

**Coaster and band**: copy `coaster/src/secrets.example.h` to `secrets.h` and fill it in, then `pio run -t upload` from `coaster/` or `band-firmware/`. Both include `shared/` with `-I ../shared`.

## Working together

Commit and push often, keep `main` working, and pull before starting anything new. Tag the commit `demo` right before the feature freeze so there is something to roll back to.
