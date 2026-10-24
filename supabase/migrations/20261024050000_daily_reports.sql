-- Daily report: the day's drinking patterns, saved once per account per day.
--
-- Built at the end of the day by the scheduled job (alongside the 8 PM
-- summary push), finalised just after midnight so late sips are included, and
-- on demand from the Summary page. Readable by the account itself and by
-- everyone who takes care of it, through the same has_access() rule as events.
--
-- The report holds facts only (amounts, counts, timings, per time of day, and
-- a comparison with the previous week). The app turns them into sentences, so
-- the wording can change without rebuilding stored reports. Descriptive only:
-- nothing here is medical advice.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.daily_reports (
  main_id      uuid not null references public.profiles (id) on delete cascade,
  date         date not null,                 -- the account's local date
  report       jsonb not null,
  generated_at timestamptz not null default now(),
  primary key (main_id, date)
);

alter table public.daily_reports enable row level security;

create policy daily_reports_select on public.daily_reports for select to authenticated
  using (public.has_access(main_id));

-- Written only by the functions below.
revoke all on public.daily_reports from anon, authenticated;
grant select on public.daily_reports to authenticated;

-- The Summary page updates when the nightly job writes a report.
alter publication supabase_realtime add table public.daily_reports;

-- ---------------------------------------------------------------------------
-- Builder (server-only: pg_cron, and the RPC below)
-- ---------------------------------------------------------------------------

-- Time of day buckets, by local wall-clock hour.
create or replace function public.day_period(p_hour int)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_hour < 12 then 'morning' when p_hour < 17 then 'afternoon' else 'evening' end;
$$;

create or replace function public.build_daily_report(p_main uuid, p_date date)
returns public.daily_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz       text;
  v_goal     integer;
  v_start    timestamptz;
  v_end      timestamptz;
  v_dow      integer;
  v_now_time time;
  v_done     boolean;
  v_report   jsonb;
  v_row      public.daily_reports;
begin
  select timezone, daily_goal_ml into v_tz, v_goal from public.profiles where id = p_main;
  if not found then
    raise exception 'Unknown account';
  end if;

  v_start    := p_date::timestamp at time zone v_tz;
  v_end      := (p_date + 1)::timestamp at time zone v_tz;
  v_dow      := extract(dow from p_date)::int;
  v_done     := now() >= v_end;
  v_now_time := (now() at time zone v_tz)::time;

  with ev as (
    select e.* from public.events e
    where e.main_id = p_main and e.created_at >= v_start and e.created_at < v_end
  ),
  -- One row per reminder that went off, with what followed it.
  fir as (
    select r.reminder_id,
           r.reminder_slot_id,
           r.reminder_slot_id is not null as scheduled,
           r.created_at as fired_at,
           (r.created_at at time zone v_tz) as local_at,
           s.amount_ml as target_ml,
           coalesce(sum(x.amount_ml) filter (where x.type = 'sip'), 0)::int as drank_ml,
           min(x.created_at) filter (where x.type = 'sip') as first_sip_at,
           min(x.created_at) filter (where x.type = 'completed') as completed_at,
           coalesce(bool_or(x.type = 'completed'), false) as completed,
           coalesce(bool_or(x.type = 'ignored'), false) as ignored
    from ev r
    left join public.reminder_slots s on s.id = r.reminder_slot_id
    left join ev x on x.reminder_id = r.reminder_id and x.type <> 'reminder'
    where r.type = 'reminder'
    group by r.id, r.reminder_id, r.reminder_slot_id, r.created_at, s.amount_ml
  ),
  f as (
    select fir.*,
           public.day_period(extract(hour from local_at)::int) as period,
           case when completed then 'completed' when ignored then 'ignored' else 'open' end as outcome,
           (extract(epoch from first_sip_at - fired_at) / 60.0)::float8 as first_sip_min,
           (extract(epoch from completed_at - fired_at) / 60.0)::float8 as complete_min
    from fir
  ),
  -- The day's schedule: slots on this weekday that existed by the end of it.
  slot as (
    select s.id, s.time_of_day, s.amount_ml,
           public.day_period(extract(hour from s.time_of_day)::int) as period
    from public.reminder_slots s
    where s.main_id = p_main
      and (s.days_mask & (1 << v_dow)) <> 0
      and s.created_at < v_end
  ),
  sips as (select amount_ml from ev where type = 'sip'),
  periods as (
    select p.name, p.ord,
           coalesce((select sum(amount_ml) from slot where slot.period = p.name), 0)::int as planned_ml,
           coalesce((select sum(drank_ml) from f where f.period = p.name), 0)::int as drank_ml,
           (select count(*) from f where f.period = p.name)::int as sent,
           (select count(*) from f where f.period = p.name and f.outcome = 'ignored')::int as ignored
    from (values ('morning', 1), ('afternoon', 2), ('evening', 3)) as p(name, ord)
  ),
  -- The previous 7 days that had any reminders, for comparison.
  prev as (
    select (e.created_at at time zone v_tz)::date as d,
           coalesce(sum(e.amount_ml) filter (where e.type = 'sip'), 0) as total
    from public.events e
    where e.main_id = p_main
      and e.created_at >= (p_date - 7)::timestamp at time zone v_tz
      and e.created_at < v_start
    group by 1
    having count(*) filter (where e.type = 'reminder') > 0
  )
  select jsonb_build_object(
    'date', p_date,
    'day_complete', v_done,
    'goal_ml', v_goal,
    'planned_ml', (select coalesce(sum(amount_ml), 0) from slot),
    'total_ml', (select coalesce(sum(amount_ml), 0) from sips),
    'reminders', jsonb_build_object(
      'sent', (select count(*) from f),
      'completed', (select count(*) from f where outcome = 'completed'),
      'ignored', (select count(*) from f where outcome = 'ignored'),
      'open', (select count(*) from f where outcome = 'open'),
      'unscheduled', (select count(*) from f where not scheduled),
      -- Scheduled, already due, and never went off (coaster offline, or off).
      'missed', (select count(*) from slot
                 where (v_done or slot.time_of_day < v_now_time)
                   and not exists (select 1 from f where f.reminder_slot_id = slot.id))),
    'sips', jsonb_build_object(
      'count', (select count(*) from sips),
      'average_ml', (select round(avg(amount_ml)) from sips),
      'largest_ml', (select max(amount_ml) from sips)),
    'first_sip_median_min', (select round((percentile_cont(0.5) within group (order by first_sip_min))::numeric, 1)
                             from f where first_sip_min is not null),
    'complete_median_min', (select round((percentile_cont(0.5) within group (order by complete_min))::numeric, 1)
                            from f where complete_min is not null),
    'periods', (select jsonb_agg(jsonb_build_object(
                  'name', name, 'planned_ml', planned_ml, 'drank_ml', drank_ml,
                  'sent', sent, 'ignored', ignored) order by ord) from periods),
    'week', jsonb_build_object(
      'days', (select count(*) from prev),
      'average_ml', (select round(avg(total)) from prev),
      'goal_met_days', (select count(*) from prev where total >= v_goal)),
    'firings', coalesce((select jsonb_agg(jsonb_build_object(
                  'time', to_char(local_at, 'HH24:MI'),
                  'scheduled', scheduled,
                  'target_ml', target_ml,
                  'drank_ml', drank_ml,
                  'outcome', outcome,
                  'first_sip_min', round(first_sip_min::numeric, 1)) order by local_at) from f), '[]'::jsonb)
  ) into v_report;

  insert into public.daily_reports (main_id, date, report, generated_at)
  values (p_main, p_date, v_report, now())
  on conflict (main_id, date) do update
    set report = excluded.report, generated_at = excluded.generated_at
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.build_daily_report(uuid, date) from public, anon, authenticated;
grant  execute on function public.build_daily_report(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- App RPC: "Create report now" on the Summary page
-- ---------------------------------------------------------------------------

create or replace function public.refresh_daily_report(p_main uuid, p_date date default null)
returns public.daily_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz    text;
  v_today date;
begin
  if not public.has_access(p_main) then
    raise exception 'Not allowed';
  end if;

  select timezone into v_tz from public.profiles where id = p_main;
  v_today := (now() at time zone v_tz)::date;
  if p_date is not null and p_date > v_today then
    raise exception 'That day has not happened yet';
  end if;

  return public.build_daily_report(p_main, coalesce(p_date, v_today));
end;
$$;

revoke execute on function public.refresh_daily_report(uuid, date) from public, anon;
grant  execute on function public.refresh_daily_report(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The scheduled job, now also writing the report.
-- Same as 20261024040000_scheduled_pushes.sql, plus two calls marked REPORT.
--
--   summary  at or after 20:00 local, once per day, if the day had any
--            reminders planned or any water drunk. The report is built first.
--   behind   between 14:00 and 20:00 local, once per day, when enough of the
--            day's reminders have gone by that 40% of the day's planned amount
--            could have been drunk, and it hasn't been. Reminders count as
--            "gone by" 30 minutes after their time, so one still in progress
--            isn't counted against the person.
-- ---------------------------------------------------------------------------

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
      -- REPORT: rebuild yesterday's report as final, if that day had one.
      if exists (select 1 from public.daily_reports d where d.main_id = r.id and d.date = r.local_date - 1) then
        perform public.build_daily_report(r.id, r.local_date - 1);
      end if;
    end if;

    if r.local_time >= c_summary_at then
      if r.planned > 0 or r.drank > 0 then
        insert into public.push_log (main_id, kind, date)
        values (r.id, 'summary', r.local_date)
        on conflict do nothing;
        if found then
          -- REPORT: the end-of-day report, ready before the push that links to it.
          perform public.build_daily_report(r.id, r.local_date);
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
