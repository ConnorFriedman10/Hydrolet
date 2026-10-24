-- Weekly reminder schedule.
--
-- Replaces profiles.schedule (one list of times repeated every day) with a
-- table of reminder slots. Each slot is a time of day, the set of weekdays it
-- fires on, and its own water target. A day's schedule is every slot whose
-- days_mask includes that day.
--
-- See docs/schedule-plan.md.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

-- days_mask is a 7-bit value: bit 0 = Sunday .. bit 6 = Saturday, matching
-- JavaScript's Date.getDay() so the app needs no translation table.
-- 127 = every day. 0 is rejected: a slot that fires on no day is meaningless.
create table public.reminder_slots (
  id          uuid primary key default gen_random_uuid(),
  main_id     uuid not null references public.profiles (id) on delete cascade,
  time_of_day time not null,            -- local wall-clock time, in profiles.timezone
  days_mask   smallint not null check (days_mask between 1 and 127),
  amount_ml   integer not null check (amount_ml > 0 and amount_ml <= 2000),
  created_at  timestamptz not null default now()
);

create index reminder_slots_main_idx on public.reminder_slots (main_id);

-- Links a fired reminder back to the slot that scheduled it, so the dashboard
-- can tell "the 9am reminder, completed" from an unscheduled "remind her now".
-- Only the 'reminder' event of a firing sets this; the sip/completed/ignored
-- rows that follow share that firing's reminder_id and are found through it.
alter table public.events
  add column reminder_slot_id uuid references public.reminder_slots (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Reads go straight through RLS. Writes are revoked and must go through the
-- RPCs below, so the no-overlap check can never be bypassed by a direct
-- .insert()/.update() from a client.
-- ---------------------------------------------------------------------------

alter table public.reminder_slots enable row level security;

create policy reminder_slots_select on public.reminder_slots for select to authenticated
  using (public.has_access(main_id));

revoke all on public.reminder_slots from anon, authenticated;
grant select on public.reminder_slots to authenticated;

-- ---------------------------------------------------------------------------
-- Write RPCs
-- ---------------------------------------------------------------------------

-- Create a slot (p_id null) or edit one in place. Rejects a slot that would
-- land on the same time as another slot they share at least one weekday with.
create or replace function public.upsert_reminder_slot(
  p_main      uuid,
  p_time      time,
  p_days_mask smallint,
  p_amount_ml integer,
  p_id        uuid default null
)
returns public.reminder_slots
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reminder_slots;
begin
  if not public.has_access(p_main) then
    raise exception 'Not allowed';
  end if;

  if exists (
    select 1 from public.reminder_slots
    where main_id = p_main
      and id is distinct from p_id
      and (days_mask & p_days_mask) <> 0
      and time_of_day = p_time
  ) then
    raise exception 'That time already has a reminder on an overlapping day';
  end if;

  if p_id is null then
    insert into public.reminder_slots (main_id, time_of_day, days_mask, amount_ml)
    values (p_main, p_time, p_days_mask, p_amount_ml)
    returning * into v_row;
  else
    update public.reminder_slots
    set time_of_day = p_time, days_mask = p_days_mask, amount_ml = p_amount_ml
    where id = p_id and main_id = p_main
    returning * into v_row;

    if not found then
      raise exception 'Reminder not found';
    end if;
  end if;

  return v_row;
end;
$$;

create or replace function public.delete_reminder_slot(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.reminder_slots
  where id = p_id and public.has_access(main_id);

  if not found then
    raise exception 'Reminder not found';
  end if;
end;
$$;

revoke execute on function public.upsert_reminder_slot(uuid, time, smallint, integer, uuid) from public, anon;
revoke execute on function public.delete_reminder_slot(uuid) from public, anon;
grant  execute on function public.upsert_reminder_slot(uuid, time, smallint, integer, uuid) to authenticated;
grant  execute on function public.delete_reminder_slot(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: the Schedule page and the Dashboard timeline both update live when
-- another caregiver edits the schedule.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.reminder_slots;

-- ---------------------------------------------------------------------------
-- The old flat schedule column is now unused. Nothing reads or writes it after
-- this migration; it is left in place deliberately rather than dropped. Run
-- this when you want it gone:
--
--   alter table public.profiles drop column schedule;
-- ---------------------------------------------------------------------------
