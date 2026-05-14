-- Per-teacher daily Gemini-call rate limit. Defensive against retry storms
-- and runaway loops — not a budget control. Audio Gemini calls are ~$0.11
-- each at Standard tier; cap of 15/day means worst case ~$1.65/day per
-- teacher even if something goes off the rails.
--
-- Storage: one row per (teacher_id, date). The app calls
-- check_and_increment_gemini_call() before every Gemini audio call; the
-- function is SECURITY DEFINER and does the read+increment atomically under
-- FOR UPDATE.

create table gemini_usage_daily (
  teacher_id uuid not null references teachers(id) on delete cascade,
  date date not null,
  calls int not null default 0,
  denials int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (teacher_id, date)
);

alter table gemini_usage_daily enable row level security;

-- Teachers see their own daily counts (used by the dashboard to show usage).
-- Admins see everyone. Writes only via the SECURITY DEFINER function below.
create policy gemini_usage_daily_select on gemini_usage_daily
  for select using (is_teacher_owner(teacher_id) or is_admin());

revoke insert, update, delete on gemini_usage_daily from authenticated;

-- Atomic check + increment. Caller passes the env-driven default cap; the
-- function applies the per-teacher override (teachers.gemini_daily_cap) if
-- set, otherwise the default. Returns the decision plus post-state for UIs
-- that want to surface "you have N calls left today".
--
-- Behavior:
--   - Looks up effective cap = coalesce(teachers.gemini_daily_cap, p_default_cap).
--   - Seeds today's row if absent.
--   - Locks the row FOR UPDATE, reads `calls`, decides allow/deny.
--   - Allow:  calls += 1, returns allowed=true.
--   - Deny:   denials += 1, returns allowed=false.
create or replace function check_and_increment_gemini_call(
  p_teacher_id uuid,
  p_default_cap int
)
returns table(allowed boolean, calls_today int, denials_today int, daily_cap int)
language plpgsql security definer set search_path = public
as $$
declare
  v_cap int;
  v_calls int;
  v_denials int;
  v_date date := current_date;
begin
  select coalesce(t.gemini_daily_cap, p_default_cap) into v_cap
    from teachers t where t.id = p_teacher_id;
  if v_cap is null then v_cap := coalesce(p_default_cap, 15); end if;

  insert into gemini_usage_daily(teacher_id, date)
    values (p_teacher_id, v_date)
    on conflict (teacher_id, date) do nothing;

  select calls, denials into v_calls, v_denials
    from gemini_usage_daily
    where teacher_id = p_teacher_id and date = v_date
    for update;

  if v_calls >= v_cap then
    update gemini_usage_daily
      set denials = denials + 1, updated_at = now()
      where teacher_id = p_teacher_id and date = v_date;
    return query select false, v_calls, v_denials + 1, v_cap;
  else
    update gemini_usage_daily
      set calls = calls + 1, updated_at = now()
      where teacher_id = p_teacher_id and date = v_date;
    return query select true, v_calls + 1, v_denials, v_cap;
  end if;
end;
$$;

-- EXECUTE grants. Anon can't call it; authenticated calls go through it for
-- their own teacher_id (defense via app-layer authorization, since the
-- function takes the id as a parameter). service_role too for cron paths.
revoke all on function check_and_increment_gemini_call(uuid, int) from public;
revoke all on function check_and_increment_gemini_call(uuid, int) from anon;
grant execute on function check_and_increment_gemini_call(uuid, int) to authenticated;
grant execute on function check_and_increment_gemini_call(uuid, int) to service_role;
