-- Replaces the caregiver_links table with a list on each profile:
--   profiles.caretaker_of = the ids of the accounts this user takes care of.
-- A user joins that list by entering the other account's caregiver code.

alter table public.profiles
  add column caretaker_of uuid[] not null default '{}';

create index profiles_caretaker_of_idx on public.profiles using gin (caretaker_of);

-- Carry over any links made with the old table.
update public.profiles p
set caretaker_of = coalesce(
  (select array_agg(l.main_id) from public.caregiver_links l where l.caregiver_id = p.id),
  '{}'
);

-- Access check: myself, or an account in my caretaker_of list.
-- security definer so policies on profiles don't recurse through RLS.
create or replace function public.has_access(p_main uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_main = auth.uid()
      or exists (
        select 1 from public.profiles
        where id = auth.uid() and p_main = any (caretaker_of)
      );
$$;

-- You can read your own profile, accounts you care for, and (as a main account) the
-- profiles of people who list you in their caretaker_of.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (public.has_access(id) or auth.uid() = any (caretaker_of));

-- caretaker_of is not in the update column grant, so it only changes through the RPCs below.
-- (Existing grant covers name, daily_goal_ml, schedule, timezone only.)

-- Entering a code adds that account to your caretaker_of list. Returns the main account's id.
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

  update public.profiles
  set caretaker_of = array_append(caretaker_of, v_main)
  where id = auth.uid() and not (v_main = any (caretaker_of));

  return v_main;
end;
$$;

-- A main account removes someone who cares for them.
create or replace function public.remove_caregiver(p_caregiver uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set caretaker_of = array_remove(caretaker_of, auth.uid())
  where id = p_caregiver;
$$;

-- A caregiver stops caring for an account.
create or replace function public.stop_caring_for(p_main uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set caretaker_of = array_remove(caretaker_of, p_main)
  where id = auth.uid();
$$;

revoke execute on function public.remove_caregiver(uuid) from public, anon;
revoke execute on function public.stop_caring_for(uuid)  from public, anon;
grant  execute on function public.remove_caregiver(uuid) to authenticated;
grant  execute on function public.stop_caring_for(uuid)  to authenticated;

-- The old table and its policies go away with it.
drop table public.caregiver_links;
