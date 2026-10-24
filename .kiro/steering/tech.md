# Hydrolet: tech stack

## App (`app/`)

React + Vite + TypeScript PWA, hosted on Vercel or Netlify (HTTPS is required for PWA and push). Routing with react-router-dom. No UI library; designs come from Claude Design mockups in `docs/mockups/` and are a visual reference only.

## Backend (`supabase/`)

- Supabase Auth (email login), Postgres with row-level security, Realtime on `events` and `devices`.
- Edge Functions (Deno): `device-api` (what the coaster calls) and `send-push` (Web Push).
- pg_cron for the daily summary and the behind-schedule check.
- Push: standard Web Push with VAPID keys; the private key is a Supabase secret. Fallback: Firebase Cloud Messaging.
- Migrations live in `supabase/migrations/` and are applied in filename order.

## Hardware (`coaster/`, `watch/`)

- PlatformIO with the Arduino framework, inside Kiro. Both boards are Seeed XIAO ESP32-C3-class boards.
- Load cell: HX711 (bogde library). LEDs: Adafruit NeoPixel.
- Bluetooth: NimBLE-Arduino (much lighter than the default BLE library with Wi-Fi on the C3).
- Coaster to cloud: ESP32 `HTTPClient` + `ArduinoJson`, plain HTTPS to `device-api`.
- Both projects include `shared/ble_protocol.h` via `-I ../shared`.
- Wi-Fi must be 2.4 GHz.

## Secrets

Never commit `.env`, `secrets.h`, or any key. Commit the `.example` versions. The Supabase service role key lives only in Edge Function secrets. The app uses the publishable (anon) key.
