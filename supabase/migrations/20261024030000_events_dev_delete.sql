-- Lets the hidden /dev page clear fake events it created, so the dashboard and
-- timeline can be reset between demo runs without going to the SQL editor.
--
-- DEV ONLY. Together with events_insert_dev, this lets any account (and any of
-- its caregivers) write and erase its own hydration history. Drop both before
-- this is used by real people:
--
--   drop policy events_delete_dev on public.events;
--   drop policy events_insert_dev on public.events;
--
-- Real events come from the coaster through device-api, which uses the service
-- role and is not affected by these policies.

create policy events_delete_dev on public.events for delete to authenticated
  using (public.has_access(main_id));

grant delete on public.events to authenticated;
