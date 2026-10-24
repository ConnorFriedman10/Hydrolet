-- Keeps summaries current instead of only refreshing them at the evening push.
--
--   - Any event written, changed or deleted recomputes the summary for that
--     event's local day (and the old day, if an update moved it).
--   - Changing daily_goal_ml updates today's goal_ml. Past days keep the goal
--     that was in force on that day, since that is what she was measured against.
--   - summaries joins the realtime publication, so the Summary page's history
--     list updates live. Row-level security still limits who sees which rows.

create or replace function public.refresh_summary_for_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
begin
  -- A summary problem must never stop an event from being saved: the coaster
  -- would retry it forever. Log it and move on.
  begin
    if tg_op in ('INSERT', 'UPDATE') then
      select timezone into v_tz from public.profiles where id = new.main_id;
      if v_tz is not null then
        perform public.compute_daily_summary(new.main_id, (new.created_at at time zone v_tz)::date);
      end if;
    end if;

    if tg_op = 'DELETE' or (tg_op = 'UPDATE' and
        (old.main_id, old.created_at) is distinct from (new.main_id, new.created_at)) then
      -- Null while the profile itself is being deleted (cascade); skip then.
      select timezone into v_tz from public.profiles where id = old.main_id;
      if v_tz is not null then
        perform public.compute_daily_summary(old.main_id, (old.created_at at time zone v_tz)::date);
      end if;
    end if;
  exception when others then
    raise warning 'refresh_summary_for_event: %', sqlerrm;
  end;
  return null;
end;
$$;

create trigger events_refresh_summary
  after insert or update or delete on public.events
  for each row execute function public.refresh_summary_for_event();

create or replace function public.refresh_summary_goal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    update public.summaries
    set goal_ml = new.daily_goal_ml
    where main_id = new.id
      and date = (now() at time zone new.timezone)::date;
  exception when others then
    raise warning 'refresh_summary_goal: %', sqlerrm;
  end;
  return null;
end;
$$;

create trigger profiles_refresh_summary_goal
  after update of daily_goal_ml on public.profiles
  for each row
  when (old.daily_goal_ml is distinct from new.daily_goal_ml)
  execute function public.refresh_summary_goal();

revoke execute on function public.refresh_summary_for_event() from public, anon, authenticated;
revoke execute on function public.refresh_summary_goal() from public, anon, authenticated;

-- Backfill: every day that has events, in each account's own timezone.
select public.compute_daily_summary(d.main_id, d.local_date)
from (
  select distinct e.main_id, (e.created_at at time zone p.timezone)::date as local_date
  from public.events e
  join public.profiles p on p.id = e.main_id
  where p.timezone in (select name from pg_timezone_names)
) d;

alter publication supabase_realtime add table public.summaries;
