-- Scheduled pushes: the evening summary and the behind-schedule alert.
--
-- pg_cron runs public.run_scheduled_pushes() every 5 minutes. For each account
-- with a schedule it works out the account's own local time and decides:
--
--   summary  at or after 20:00 local, once per day, if the day had any
--            reminders planned or any water drunk.
--   behind   between 14:00 and 20:00 local, once per day, when enough of the
--            day's reminders have gone by that she could have drunk 40% of
--            the day's planned amount, and she hasn't. Reminders count as
--            "gone by" 30 minutes after their time, so one still in progress
--            isn't held against her.
--
-- "Planned" is the sum of that weekday's reminder amounts, the same target the
-- dashboard shows. Only water drunk during reminders is measured.
--
-- Each push is a pg_net request to the send-push Edge Function, which does the
-- sending. push_log makes every push at-most-once per account per day, even if
-- a run overlaps the next one.
--
-- Authentication: send-push is deployed with JWT verification off and checks
-- an X-Cron-Secret header itself, through check_cron_secret(). The secret is
-- generated here, inside the database, and lives only in Vault. Nothing
-- outside Postgres ever needs to know it.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- Vault: where send-push lives, and the secret that proves a call is ours
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'hydrolet_cron_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'hydrolet_cron_secret',
      'Sent by pg_cron to send-push as X-Cron-Secret');
  end if;

  -- Points at this project. Change it with vault.update_secret() if the
  -- migrations are ever applied to a different one.
  if not exists (select 1 from vault.secrets where name = 'hydrolet_project_url') then
    perform vault.create_secret(
      'https://nfgmrapqkujdcbokmdul.supabase.co',
      'hydrolet_project_url',
      'Base URL for calling Edge Functions from pg_cron');
  end if;
end;
$$;

-- send-push calls this with the service role to check an X-Cron-Secret header.
create or replace function public.check_cron_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(length(p_secret) > 0, false) and exists (
    select 1 from vault.decrypted_secrets
    where name = 'hydrolet_cron_secret' and decrypted_secret = p_secret
  );
$$;

revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant  execute on function public.check_cron_secret(text) to service_role;

-- ---------------------------------------------------------------------------
-- push_log: one row per push sent by the schedule. Server-only.
-- ---------------------------------------------------------------------------

create table public.push_log (
  main_id uuid not null references public.profiles (id) on delete cascade,
  kind    text not null check (kind in ('summary', 'behind')),
  date    date not null,              -- the account's local date
  sent_at timestamptz not null default now(),
  primary key (main_id, kind, date)
);

alter table public.push_log enable row level security;
revoke all on public.push_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The job
-- ---------------------------------------------------------------------------

-- Returns how many pushes it queued.
create or replace function public.run_scheduled_pushes()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  c_summary_at   constant time    := '20:00';
  c_behind_from  constant time    := '14:00';
  c_behind_share constant numeric := 0.4;
  c_grace        constant interval := '30 minutes';

  v_url    text;
  v_secret text;
  v_queued integer := 0;
  r        record;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'hydrolet_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'hydrolet_cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'run_scheduled_pushes: Vault secrets missing, nothing sent';
    return 0;
  end if;

  for r in
    with acct as (
      select p.id, p.timezone, (now() at time zone p.timezone) as local_now
      from public.profiles p
      where exists (select 1 from public.reminder_slots s where s.main_id = p.id)
        -- A bad timezone would raise and stop the whole run for everyone.
        and p.timezone in (select name from pg_timezone_names)
    ),
    today as (
      select a.id,
             a.local_now::date as local_date,
             a.local_now::time as local_time,
             a.local_now::date::timestamp at time zone a.timezone as day_start,
             1 << extract(dow from a.local_now)::int as day_bit
      from acct a
    )
    select t.*,
           coalesce((
             select sum(s.amount_ml) from public.reminder_slots s
             where s.main_id = t.id and (s.days_mask & t.day_bit) <> 0
           ), 0) as planned,
           coalesce((
             select sum(s.amount_ml) from public.reminder_slots s
             where s.main_id = t.id and (s.days_mask & t.day_bit) <> 0
               and s.time_of_day + c_grace <= t.local_time
               and s.time_of_day < time '23:30'  -- adding the grace would wrap past midnight
           ), 0) as due,
           coalesce((
             select sum(e.amount_ml) from public.events e
             where e.main_id = t.id and e.type = 'sip' and e.created_at >= t.day_start
           ), 0) as drank
    from today t
  loop
    -- Shortly after local midnight, close out yesterday's numbers so late sips
    -- after the evening summary still land in the history.
    if r.local_time < time '00:10' then
      perform public.compute_daily_summary(r.id, r.local_date - 1);
    end if;

    if r.local_time >= c_summary_at then
      if r.planned > 0 or r.drank > 0 then
        insert into public.push_log (main_id, kind, date)
        values (r.id, 'summary', r.local_date)
        on conflict do nothing;
        if found then
          perform net.http_post(
            url := v_url || '/functions/v1/send-push',
            body := jsonb_build_object('kind', 'summary', 'main_id', r.id, 'date', r.local_date),
            headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
            timeout_milliseconds := 30000);
          v_queued := v_queued + 1;
        end if;
      end if;

    elsif r.local_time >= c_behind_from
      and r.planned > 0
      and r.due >= c_behind_share * r.planned
      and r.drank < c_behind_share * r.planned
    then
      insert into public.push_log (main_id, kind, date)
      values (r.id, 'behind', r.local_date)
      on conflict do nothing;
      if found then
        perform net.http_post(
          url := v_url || '/functions/v1/send-push',
          body := jsonb_build_object('kind', 'behind', 'main_id', r.id),
          headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
          timeout_milliseconds := 30000);
        v_queued := v_queued + 1;
      end if;
    end if;
  end loop;

  return v_queued;
end;
$$;

revoke execute on function public.run_scheduled_pushes() from public, anon, authenticated;

-- Re-running cron.schedule with the same name updates the job in place.
select cron.schedule('hydrolet-scheduled-pushes', '*/5 * * * *', 'select public.run_scheduled_pushes()');
