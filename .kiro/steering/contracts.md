# Hydrolet: contracts

These are the only things the app side and the hardware side both depend on. Tell the other person before changing one. The SQL in `supabase/migrations/` is the source of truth for tables.

## Tables (Supabase Postgres)

```
profiles            id (= auth user id), name, caregiver_code (unique), caretaker_of (uuid[]),
                    daily_goal_ml, schedule (jsonb), timezone
events              id, main_id, type (reminder/sip/refill/completed/ignored), amount_ml,
                    reminder_id (uuid, groups one reminder's events), created_at
summaries           main_id, date, total_ml, goal_ml, reminders_sent, reminders_ignored
devices             id, owner_id, type (coaster/watch), device_secret_hash, last_seen, pending_command
push_subscriptions  user_id, endpoint, p256dh, auth
```

- `caretaker_of` is the list of account ids this user takes care of. A user is added by entering the other account's `caregiver_code` (RPC `redeem_caregiver_code`).
- Schedule format: `{ "reminders": ["09:00", "11:30"] }`, local times in `timezone`.
- `pending_command` values: `remindNow`, `timelapse_on`, `timelapse_off`.

## Device API (coaster to Supabase)

Edge Function `device-api`, deployed with JWT verification off. Every request carries `X-Device-Id` and `X-Device-Secret` headers; the function hashes the secret with SHA-256 and compares it to `devices.device_secret_hash`.

| Request | Sent when | Response |
|---|---|---|
| `POST /event` | sip, refill, reminder, completed or ignored reminder | OK |
| `POST /checkin` | every few seconds; says whether the watch is connected | schedule, daily goal, pending command (then cleared) |

Each check-in updates `last_seen` for the coaster (and the watch, if connected). The coaster generates a UUID per reminder and sends it as `reminder_id` on every event for that reminder.

## BLE (coaster to watch)

UUIDs and command values are in `shared/ble_protocol.h`. Commands: remind, quiet, clear, test. Watch events: ignored, button press.
