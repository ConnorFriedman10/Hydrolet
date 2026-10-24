# Weekly reminder schedule: implementation plan

Scope: replace the flat `profiles.schedule` (a single list of times repeated every day) with a weekly, per-day-customizable set of reminders, each with its own amount. Covers the database, the contract with the coaster, the app's Schedule page, and a today's-timeline view on the Dashboard. Auto-generating a schedule for the user is explicitly **out of scope** for this pass — build the manual editor first.

## The model, in plain terms

A **reminder** is one row: a time of day, the set of days of the week it fires on, and an amount of water for that firing. There is no single "the schedule" list anymore — a day's schedule is just "every reminder whose day-set includes today," sorted by time.

- "Occurs every day" = a reminder whose day-set is all seven days.
- "Occurs on selected days" = a reminder whose day-set is some subset (e.g. Mon/Wed/Fri).
- "No two reminders overlap on the same day" = for any day, no two reminders that both fire that day may have the same time.
- Changing "day by day" falls out naturally: a Saturday-only reminder and a weekday-only reminder are just two different rows, not an exception mechanism bolted onto a single list.

This replaces the old assumption (one list of times, applied identically every day, with the goal divided evenly across them). It also simplifies the coaster: instead of "divide the goal by the reminder count," each reminder already carries its own target amount.

## Naming: don't confuse this with `events`

`events` already has a row type `'reminder'`, which is a **log entry** for one firing that happened. The new table is the **schedule definition** — call it `reminder_slots`, not `reminders`, so the two are never confused in code or conversation. One `reminder_slots` row can produce many `events` rows over time (one firing per matching day).

## Data model

```sql
create table public.reminder_slots (
  id         uuid primary key default gen_random_uuid(),
  main_id    uuid not null references public.profiles (id) on delete cascade,
  time       time not null,                         -- local wall-clock time, in profiles.timezone
  days_mask  smallint not null check (days_mask between 1 and 127),  -- bit 0 = Sun ... bit 6 = Sat
  amount_ml  integer not null check (amount_ml > 0 and amount_ml <= 2000),
  created_at timestamptz not null default now()
);
create index reminder_slots_main_idx on public.reminder_slots (main_id);
```

- **`days_mask`**: a 7-bit value, bit 0 = Sunday through bit 6 = Saturday (matches JS `Date.getDay()`, so the app's bit math and day labels line up with no translation table). `127` = every day. The check constraint rejects `0` (a reminder active on no days makes no sense).
- **`time`**: Postgres `time`, no date, no time zone — interpreted using `profiles.timezone`, same convention the old `schedule` jsonb used.
- **`amount_ml`**: capped at 2000 as a sanity bound; the "same across the board" convenience (mentioned in the request) is a client-side default that pre-fills the amount field on new reminders — not something stored on the server, since it's just a form shortcut, not a rule anyone else needs to see.
- `profiles.daily_goal_ml` stays as-is: the doctor-confirmed ceiling. It is **not** forced to equal the sum of reminder amounts. The Schedule page shows both and flags it gently if they drift apart, but doesn't block saving — a caregiver might intentionally leave headroom for what she drinks on her own.
- **`profiles.schedule` (the old jsonb column) is dropped** once this ships, the same way `caregiver_links` was dropped for `caretaker_of`. I'll write it as a migration, not a hand edit, so it's reversible and reviewable.

```sql
alter table public.events
  add column reminder_slot_id uuid references public.reminder_slots (id) on delete set null;
```

This was "optional, not blocking" in the first draft of this plan, before the Dashboard timeline was in scope. It's needed now: it's how the dashboard tells "this is the 9am reminder, already completed" apart from an unscheduled "remind her now" that just fired. Only the `'reminder'` event of a firing needs it set — the `sip`/`completed`/`ignored` rows that follow already share that firing's `reminder_id`, so the dashboard looks up the slot through that group rather than repeating the link on every row.

### Why the conflict rule lives in a function, not a DB constraint

A true "no overlapping day-sets at the same time" rule needs an exclusion constraint comparing bitmask overlap, which Postgres can't express without extra extensions and a custom operator class — a lot of machinery for a hackathon. Instead, two `SECURITY DEFINER` RPCs do the check-then-write inside one transaction:

```sql
-- Create or edit a reminder. p_id = null to create; pass an id to edit it in place.
create or replace function public.upsert_reminder_slot(
  p_main uuid, p_id uuid, p_time time, p_days_mask smallint, p_amount_ml integer
) returns public.reminder_slots
language plpgsql security definer set search_path = public
as $$
declare
  v_conflict record;
  v_row public.reminder_slots;
begin
  if not public.has_access(p_main) then
    raise exception 'Not allowed';
  end if;

  select * into v_conflict from public.reminder_slots
  where main_id = p_main
    and id is distinct from p_id
    and (days_mask & p_days_mask) <> 0
    and time = p_time
  limit 1;

  if found then
    raise exception 'That time already has a reminder on an overlapping day';
  end if;

  if p_id is null then
    insert into public.reminder_slots (main_id, time, days_mask, amount_ml)
    values (p_main, p_time, p_days_mask, p_amount_ml)
    returning * into v_row;
  else
    update public.reminder_slots
    set time = p_time, days_mask = p_days_mask, amount_ml = p_amount_ml
    where id = p_id and main_id = p_main
    returning * into v_row;
    if not found then raise exception 'Reminder not found'; end if;
  end if;

  return v_row;
end;
$$;

create or replace function public.delete_reminder_slot(p_id uuid) returns void
language sql security definer set search_path = public
as $$
  delete from public.reminder_slots
  where id = p_id and public.has_access(main_id);
$$;
```

Reads go straight through RLS (`select` policy using `has_access(main_id)`, same pattern as `events`), since there's nothing to validate on a read. Writes are revoked from `authenticated` directly on the table and only reachable through these two functions, so the conflict check can never be bypassed by a direct `.update()` call from the client.

**Open question, flagging rather than deciding:** right now the conflict check is "same exact time." The real hardware reminder cycle takes a few minutes (three buzzes a minute apart, plus the ignored-timeout from the still-open "Open decisions" item in the main plan), so two reminders five minutes apart would pass this check but could still overlap in practice on the coaster. I'd rather ship exact-time matching now and revisit as "reminders must be at least N minutes apart" once the ignored-timeout value is settled — it's a one-line change to this function, not a schema change, so it's cheap to defer.

## Contract change for the coaster

This is the one hardware needs to know about. The old `/checkin` contract returned a generic `schedule` object and let the coaster figure out what to do with it. The new version does the day-of-week math server-side (it already knows `profiles.timezone`), so the coaster stays dumb:

```
POST /checkin  →  {
  "today_reminders": [
    { "id": "...", "time": "09:00", "amount_ml": 150 },
    { "id": "...", "time": "13:30", "amount_ml": 200 }
  ],
  "daily_goal_ml": 1500,
  "pending_command": null
}
```

- `today_reminders` is pre-filtered to the caller's local "today" and re-computed on every check-in, so midnight rollover and schedule edits both just show up on the next check-in with no logic on the firmware side.
- The coaster no longer needs to divide a goal by a reminder count — `amount_ml` is each reminder's target directly.
- I'll update `.kiro/steering/contracts.md` and flag this to the hardware lead as soon as `device-api` is written, since it hasn't been built yet — this plan should land before that function is, so it's designed against the final shape instead of needing a rework.
- `POST /event` gains one more optional field on the `'reminder'` event: `reminder_slot_id`. The coaster sends the id from the `today_reminders` entry it's acting on. For an on-demand "remind her now" fire (triggered by `pending_command`, not a scheduled slot), it's left out — the dashboard then shows that firing as an unscheduled entry at the time it happened, instead of tying it to a slot that didn't cause it.

## Dashboard: today's timeline

This is the feature just requested: both the main account and any caregiver viewing it see one ordered timeline for today, merging:

- **Scheduled reminders for today** — every `reminder_slots` row whose `days_mask` includes today's weekday (computed in the viewer's **profile timezone**, not the browser's, so a caregiver checking in from another time zone still sees "today" the way the main account experiences it). Each shows its time and planned amount.
- **What already happened** — the same `events` rows the Activity list already fetches.

Each scheduled entry gets a status, derived by matching it to events through `reminder_slot_id` → that firing's `reminder_id` group, the same correlation used above:

| Status | Meaning |
|---|---|
| **Upcoming** | Time hasn't arrived yet; no `'reminder'` event logged for this slot today. |
| **Active** | A `'reminder'` event exists for this slot today, but no `'completed'`/`'ignored'` yet — she's mid-reminder right now. |
| **Completed** | A `'completed'` event closes this slot's firing. |
| **Ignored** | An `'ignored'` event closes it instead. |

An on-demand "remind her now" firing (no `reminder_slot_id`) appears in the timeline at its actual time, labeled as unscheduled, rather than being forced onto a slot it didn't come from.

No new RPC is needed for this — both tables are already readable through existing RLS (`has_access(main_id)`), so the timeline is built client-side from two queries already in reach, filtered and merged in the browser. I'd add a `reminder_slots` realtime subscription alongside the existing `events` one on the Dashboard, so an edit to today's schedule shows up live for anyone currently viewing it.

This is scoped to **today only**, matching the Dashboard's existing "Today" focus; the Schedule page remains the place to see the rest of the week. Say if you want the timeline to look further ahead than today — that'd be a straightforward extension (just widen the day-of-week filter), not a different design.

## App: Schedule page

Replace the placeholder with:

- **Goal card** (mostly what's already planned): `daily_goal_ml` editor, with a quiet note if it doesn't match the week's reminder totals.
- **Day selector**: seven tabs or a day-of-week strip. Selecting a day filters the reminder list to rows whose `days_mask` includes that day.
- **Reminder list** for the selected day, sorted by time, each showing time, amount, and which other days it repeats on (e.g. "Every day" / "Mon, Wed, Fri").
- **Add/edit reminder form**: time picker, amount (mL, pre-filled with the last amount used), and a day picker with quick presets (Every day / Weekdays / Weekends / Custom checkboxes) plus the 7 individual toggles.
- On save, call `upsert_reminder_slot`; show the server's conflict error inline rather than re-deriving the check in the client (the client can do a soft pre-check for responsiveness, but the RPC is the real guard).
- Subscribe to `reminder_slots` via Supabase Realtime, scoped to the selected `subject.id`, the same pattern `Dashboard` uses for `events` — so if one caregiver edits while another is viewing, it updates live.
- Both the main account and any caregiver see and can edit this page identically; there's no separate "view-only" mode (matches `has_access()`, which already treats both the same way).

## Testing

Extend the existing pattern from [app/test/caregiver.test.mjs](../app/test/caregiver.test.mjs) with a sibling `schedule.test.mjs`, using the same two live accounts:

1. Connor creates a reminder, every day, 09:00, 150 mL — succeeds.
2. Connor creates a second reminder at 09:00 on Tuesday only — rejected (overlaps the daily one on Tuesday).
3. Connor deletes the daily reminder, then creates a Sat/Sun 09:00 reminder and a separate Mon–Fri 09:00 reminder — both succeed, since the two day-sets never share a day.
4. Editing a reminder to a conflicting time — rejected; editing it to a free time — succeeds.
5. Henry (not yet a caregiver) cannot read or write Connor's reminders.
6. Henry, after redeeming Connor's code, can read and write them.
7. Deleting a reminder removes it and frees up its time slot for reuse.
8. `npm run build` passes.

## Suggested build order

1. Migration: `reminder_slots` table, RLS, the two RPCs, `events.reminder_slot_id`, drop `profiles.schedule`.
2. Update `.kiro/steering/contracts.md` with the new table, the `/checkin` response shape, and the `/event` field addition.
3. `schedule.test.mjs`, run against the live project before touching the UI.
4. Rewrite `app/src/pages/Schedule.tsx` and any small components it needs (day selector, reminder row, reminder form).
5. Add the today's-timeline view to `app/src/pages/Dashboard.tsx`, alongside its existing goal/activity/device cards.
6. Manual pass in the browser with Connor and Henry, same style as the caregiver walkthrough — including watching the timeline update as fake events are added from the Dev page.

## Deliberately deferred

- **Auto-generated schedule suggestion** — the request explicitly says build the manual editor first; this becomes a later layer that writes the same `reminder_slots` rows a person would, so nothing above needs to change to add it.
- **Minimum-gap conflict rule** (vs. exact-time) — revisit once the ignored-reminder timeout is fixed.
- **Timeline beyond today** — the Dashboard stays today-only; a longer look-ahead is a filter change, not a redesign, if wanted later.
