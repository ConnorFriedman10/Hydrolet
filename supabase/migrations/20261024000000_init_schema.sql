-- Hydrolet initial schema: tables, row-level security, RPCs, realtime.
-- Contract with the hardware lead is in docs/hydrolet-plan.md (Shared contracts).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Short, unambiguous, friend-code style (no 0/O/1/I).
create or replace function public.generate_caregiver_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.profiles where caregiver_code = code);
  end loop;
  return code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Schedule format (jsonb):
--   { "reminders": ["09:00", "11:30", "14:00", "16:30"] }   local times in `timezone`
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  name           text not null default '',
  caregiver_code text not null unique default public.generate_caregiver_code(),
  daily_goal_ml  integer not null default 1500 check (daily_goal_ml between 100 and 6000),
  schedule       jsonb not null default '{"reminders": []}'::jsonb,
  timezone       text not null default 'America/New_York',  -- added to contract: summaries and cron need it
  created_at     timestamptz not null default now()
);

create table public.caregiver_links (
  caregiver_id uuid not null references public.profiles (id) on delete cascade,
  main_id      uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (caregiver_id, main_id),
  check (caregiver_id <> main_id)
);
create index caregiver_links_main_idx on public.caregiver_links (main_id);

-- reminder_id groups a reminder with its sips/completed/ignored events (added to
-- contract so the summary page can show "each reminder, when she drank, how much").
create table public.events (
  id          bigint generated always as identity primary key,
  main_id     uuid not null references public.profiles (id) on delete cascade,
  type        text not null check (type in ('reminder', 'sip', 'refill', 'completed', 'ignored')),
  amount_ml   integer check (amount_ml is null or amount_ml >= 0),
  reminder_id uuid,
  created_at  timestamptz not null default now()
);
create index events_main_created_idx on public.events (main_id, created_at desc);

create table public.summaries (
  main_id            uuid not null references public.profiles (id) on delete cascade,
  date               date not null,
  total_ml           integer not null default 0,
  goal_ml            integer not null default 0,
  reminders_sent     integer not null default 0,
  reminders_ignored  integer not null default 0,
  primary key (main_id, date)
);

create table public.devices (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.profiles (id) on delete cascade,
  type               text not null check (type in ('coaster', 'watch')),
  device_secret_hash text not null,
  last_seen          timestamptz,
  pending_command    text check (pending_command is null or pending_command in ('remindNow', 'timelapse_on', 'timelapse_off')),
  created_at         timestamptz not null default now()
);
create index devices_owner_idx on public.devices (owner_id);

create table public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- Access helper (security definer so policies don't recurse through RLS)
-- ---------------------------------------------------------------------------

create or replace function public.has_access(p_main uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_main = auth.uid()
      or exists (
        select 1 from public.caregiver_links
        where main_id = p_main and caregiver_id = auth.uid()
      );
$$;

-- ---------------------------------------------------------------------------
-- New user -> profile
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles           enable row level security;
alter table public.caregiver_links    enable row level security;
alter table public.events             enable row level security;
alter table public.summaries          enable row level security;
alter table public.devices            enable row level security;
alter table public.push_subscriptions enable row level security;

-- profiles: self, linked caregivers see the main account, and a main account sees its caregivers' names.
create policy profiles_select on public.profiles for select to authenticated
  using (
    public.has_access(id)
    or exists (
      select 1 from public.caregiver_links l
      where l.main_id = auth.uid() and l.caregiver_id = profiles.id
    )
  );

-- Caregivers may edit goal and schedule; column grants below keep caregiver_code and id out of reach.
create policy profiles_update on public.profiles for update to authenticated
  using (public.has_access(id))
  with check (public.has_access(id));

revoke update on public.profiles from anon, authenticated;
grant update (name, daily_goal_ml, schedule, timezone) on public.profiles to authenticated;

-- caregiver_links: rows are created only through redeem_caregiver_code().
create policy links_select on public.caregiver_links for select to authenticated
  using (caregiver_id = auth.uid() or main_id = auth.uid());

create policy links_delete on public.caregiver_links for delete to authenticated
  using (main_id = auth.uid() or caregiver_id = auth.uid());

-- events: device-api writes with the service role. The insert policy exists for the
-- dev page ("Simulate sip"); drop it before any real deployment.
create policy events_select on public.events for select to authenticated
  using (public.has_access(main_id));

create policy events_insert_dev on public.events for insert to authenticated
  with check (public.has_access(main_id));

-- summaries: read-only for clients; written by compute_daily_summary().
create policy summaries_select on public.summaries for select to authenticated
  using (public.has_access(main_id));

-- devices: readable for status display, never writable by clients (use send_command / register_device).
create policy devices_select on public.devices for select to authenticated
  using (public.has_access(owner_id));

revoke select on public.devices from anon, authenticated;
grant select (id, owner_id, type, last_seen, pending_command, created_at) on public.devices to authenticated;
revoke insert, update, delete on public.devices from anon, authenticated;

-- push_subscriptions: own rows only.
create policy push_all_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- anon gets nothing.
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- RPCs (called from the app)
-- ---------------------------------------------------------------------------

-- Entering someone's code makes you their caregiver. Returns the main account's id.
create or replace function public.redeem_caregiver_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_main uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select id into v_main from public.profiles
  where caregiver_code = upper(trim(p_code));

  if v_main is null then
    raise exception 'Invalid caregiver code';
  end if;
  if v_main = auth.uid() then
    raise exception 'You cannot be your own caregiver';
  end if;

  insert into public.caregiver_links (caregiver_id, main_id)
  values (auth.uid(), v_main)
  on conflict do nothing;

  return v_main;
end;
$$;

-- Main account rotates its code if it was shared too widely.
create or replace function public.regenerate_caregiver_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.generate_caregiver_code();
begin
  update public.profiles set caregiver_code = v_code where id = auth.uid();
  return v_code;
end;
$$;

-- Creates a device for a main account and returns its id and secret ONCE.
-- Only the SHA-256 hash is stored; device-api hashes the incoming secret and compares.
create or replace function public.register_device(p_type text, p_owner uuid default null)
returns table (device_id uuid, device_secret text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_owner  uuid := coalesce(p_owner, auth.uid());
  v_secret text := encode(gen_random_bytes(24), 'hex');
  v_id     uuid;
begin
  if not public.has_access(v_owner) then
    raise exception 'Not allowed';
  end if;

  insert into public.devices (owner_id, type, device_secret_hash)
  values (v_owner, p_type, encode(digest(v_secret, 'sha256'), 'hex'))
  returning id into v_id;

  return query select v_id, v_secret;
end;
$$;

-- "Remind her now" and time-lapse: queues a command for the coaster's next check-in.
create or replace function public.send_command(p_main uuid, p_command text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_access(p_main) then
    raise exception 'Not allowed';
  end if;

  update public.devices set pending_command = p_command
  where owner_id = p_main and type = 'coaster';

  if not found then
    raise exception 'No coaster registered for this account';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Daily summary (called by pg_cron / send-push / "send summary now" with service role)
-- ---------------------------------------------------------------------------

create or replace function public.compute_daily_summary(p_main uuid, p_date date default null)
returns public.summaries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz    text;
  v_goal  integer;
  v_date  date;
  v_start timestamptz;
  v_end   timestamptz;
  v_row   public.summaries;
begin
  select timezone, daily_goal_ml into v_tz, v_goal from public.profiles where id = p_main;
  if not found then
    raise exception 'Unknown main account';
  end if;

  v_date  := coalesce(p_date, (now() at time zone v_tz)::date);
  v_start := v_date::timestamp at time zone v_tz;
  v_end   := (v_date + 1)::timestamp at time zone v_tz;

  insert into public.summaries (main_id, date, total_ml, goal_ml, reminders_sent, reminders_ignored)
  select p_main, v_date,
         coalesce(sum(amount_ml) filter (where type = 'sip'), 0),
         v_goal,
         count(*) filter (where type = 'reminder'),
         count(*) filter (where type = 'ignored')
  from public.events
  where main_id = p_main and created_at >= v_start and created_at < v_end
  on conflict (main_id, date) do update
    set total_ml = excluded.total_ml,
        goal_ml = excluded.goal_ml,
        reminders_sent = excluded.reminders_sent,
        reminders_ignored = excluded.reminders_ignored
  returning * into v_row;

  return v_row;
end;
$$;

-- Function execute is public by default; lock down everything except the app RPCs.
revoke execute on function public.compute_daily_summary(uuid, date) from public, anon, authenticated;
grant  execute on function public.compute_daily_summary(uuid, date) to service_role;

revoke execute on function public.redeem_caregiver_code(text)       from public, anon;
revoke execute on function public.regenerate_caregiver_code()       from public, anon;
revoke execute on function public.register_device(text, uuid)       from public, anon;
revoke execute on function public.send_command(uuid, text)          from public, anon;
grant  execute on function public.redeem_caregiver_code(text)       to authenticated;
grant  execute on function public.regenerate_caregiver_code()       to authenticated;
grant  execute on function public.register_device(text, uuid)       to authenticated;
grant  execute on function public.send_command(uuid, text)          to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: dashboard updates as sips arrive and devices check in.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.devices;
