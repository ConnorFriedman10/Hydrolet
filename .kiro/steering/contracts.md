# Hydrolet: contracts

These are the only things the app side and the hardware side both depend on. Tell the other person before changing one. The SQL in `supabase/migrations/` is the source of truth for tables.

## Tables (Supabase Postgres)

```
profiles            id (= auth user id), name, caregiver_code (unique), caretaker_of (uuid[]),
                    daily_goal_ml, timezone
reminder_slots      id, main_id, time_of_day, days_mask, amount_ml
events              id, main_id, type (reminder/sip/refill/completed/ignored), amount_ml,
                    reminder_id (uuid, groups one firing's events), reminder_slot_id, created_at
summaries           main_id, date, total_ml, goal_ml, reminders_sent, reminders_ignored
devices             id, owner_id, type (coaster/watch), device_secret_hash, last_seen, pending_command
push_subscriptions  user_id, endpoint, p256dh, auth
```

- `caretaker_of` is the list of account ids this user takes care of. A user is added by entering the other account's `caregiver_code` (RPC `redeem_caregiver_code`).
- **`reminder_slots` is the schedule.** One row is one reminder: a local time, the weekdays it fires on, and its own water target. `days_mask` is 7 bits, bit 0 = Sunday .. bit 6 = Saturday; 127 = every day. No two slots that share a weekday may have the same time. Writes go through `upsert_reminder_slot` / `delete_reminder_slot`, never directly.
- **Each reminder carries its own `amount_ml`**, so nothing divides the daily goal by a reminder count any more. `daily_goal_ml` stays as the doctor-confirmed figure and is not required to equal the sum of the day's reminders.
- `pending_command` values: `remindNow`, `timelapse_on`, `timelapse_off`.
- The old `profiles.schedule` jsonb column still exists but is unused. Ignore it.

## Device API (coaster to Supabase)

Edge Function `device-api`, deployed with JWT verification off. Every request carries `X-Device-Id` and `X-Device-Secret` headers; the function hashes the secret with SHA-256 and compares it to `devices.device_secret_hash`.

| Request | Sent when | Response |
|---|---|---|
| `POST /event` | sip, refill, reminder, completed or ignored reminder | OK |
| `POST /checkin` | every few seconds; says whether the watch is connected | today's reminders, daily goal, pending command (then cleared) |

Each check-in updates `last_seen` for the coaster (and the watch, if connected).

`/checkin` returns the reminders for *today* only, already filtered server-side using the account's timezone and re-computed on every call. The coaster does no weekday maths and handles no midnight rollover; a schedule edit simply shows up on the next check-in:

```json
{
  "today_reminders": [
    { "id": "uuid", "time": "09:00", "amount_ml": 150 },
    { "id": "uuid", "time": "13:30", "amount_ml": 200 }
  ],
  "daily_goal_ml": 1500,
  "pending_command": null
}
```

Events for one firing:

- The coaster generates a **new UUID per firing** and sends it as `reminder_id` on every event belonging to that firing (the reminder itself, its sips, and the closing completed/ignored).
- On the `reminder` event it also sends **`reminder_slot_id`**: the `id` from the `today_reminders` entry it is acting on. For an on-demand "remind her now" (from `pending_command`, not the schedule) it is omitted — that is how the app tells a scheduled reminder apart from an ad-hoc one.

## BLE (coaster to watch)

UUIDs and command values are in `shared/ble_protocol.h`. Commands: remind, quiet, clear, test. Watch events: ignored, button press.
