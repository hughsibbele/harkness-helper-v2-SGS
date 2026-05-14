-- Harkness Helper v2 — initial schema.
--
-- Tables: teachers, students, discussions, participations.
-- RLS via auth.uid() ↔ teachers.auth_user_id. Backend writes (Inngest jobs,
-- the auto-upsert in /auth/callback) go through the service-role client and
-- bypass RLS.
--
-- No student-facing flow in Harkness v2 — students exist as a roster snapshot
-- only (no auth.users row for them), so there's no is_student_self() helper.
-- A future student-presence UI would talk to teachers' dashboards only.

-- 1) teachers ---------------------------------------------------------------
create table teachers (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  google_sub text unique,
  email text not null unique check (email = lower(email)),
  display_name text not null,
  -- Per-teacher daily Gemini cap. null falls back to GEMINI_DEFAULT_DAILY_CAP
  -- env (see migration 20260513120003_gemini_rate_limits.sql).
  gemini_daily_cap int,
  -- Last successful full Canvas-sync timestamp (cron or manual). Cache row
  -- timestamps live on the individual cache rows; this is the rollup shown
  -- in the dashboard header. Populated in Phase B.
  last_canvas_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) students --------------------------------------------------------------
-- Roster snapshot, populated from Canvas (Phase B). Lightweight — the
-- canonical authoritative roster used by the boundary scrubber lives in
-- course_rosters as a jsonb blob; this table is for joins (participations →
-- students → email) and per-student anon_token lookups by super-grader.
create table students (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_user_id text not null,
  canvas_course_id text not null,
  email text not null check (email = lower(email)),
  display_name text not null,
  anon_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One (teacher, canvas_user, canvas_course) tuple. A student who appears
  -- in two of the same teacher's courses gets two rows — different
  -- participations belong to different course contexts.
  unique (teacher_id, canvas_user_id, canvas_course_id)
);

create index students_anon_token_idx on students (anon_token);
create index students_teacher_idx on students (teacher_id);

-- 3) discussions ------------------------------------------------------------
-- One discussion = one classroom recording = one Canvas assignment.
-- transcription_prompt_id snapshots which prompt body produced this
-- transcript — editing the prompt later does not retroactively re-tag
-- historical rows.
create type discussion_state as enum (
  'uploaded',
  'transcribing',
  'transcribed',
  'posted_to_super_grader',
  'failed'
);

create type super_grader_post_status as enum (
  'pending',
  'posted',
  'error'
);

create table discussions (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_assignment_id text not null unique,
  canvas_course_id text not null,
  recorded_at date not null,
  audio_url text not null,
  transcript text,
  transcription_prompt_id uuid,   -- FK added in admins_and_prompts.sql; nullable for legacy
  state discussion_state not null default 'uploaded',
  super_grader_post_status super_grader_post_status not null default 'pending',
  super_grader_response jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index discussions_teacher_idx on discussions (teacher_id);
create index discussions_state_idx on discussions (state)
  where state in ('uploaded', 'transcribing');

-- 4) participations --------------------------------------------------------
-- Which students were present in a given discussion. The teacher marks
-- these on the upload form. No per-student grading; this just powers
-- super-grader's "this student participated" presence indicator.
create table participations (
  id uuid primary key default gen_random_uuid(),
  discussion_id uuid not null references discussions(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (discussion_id, student_id)
);

create index participations_discussion_idx on participations (discussion_id);
create index participations_student_idx on participations (student_id);

-- updated_at trigger function. Pinned search_path per Supabase linter 0011.
create or replace function set_updated_at()
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger teachers_set_updated_at before update on teachers
  for each row execute function set_updated_at();
create trigger students_set_updated_at before update on students
  for each row execute function set_updated_at();
create trigger discussions_set_updated_at before update on discussions
  for each row execute function set_updated_at();

-- RLS helper. SECURITY DEFINER so it can be called from policy expressions
-- without recursing through other tables' RLS. EXECUTE granted to
-- `authenticated` — revoking it silently breaks every policy that uses it
-- (AI Documenter learned this the hard way, see its
-- 20260507130000_restore_teacher_owner_grant.sql).
create or replace function is_teacher_owner(t_id uuid)
returns boolean language sql security definer set search_path = public, auth as $$
  select exists (
    select 1 from teachers t
    where t.id = t_id and t.auth_user_id = auth.uid()
  );
$$;

revoke execute on function is_teacher_owner(uuid) from public;
revoke execute on function is_teacher_owner(uuid) from anon;
grant execute on function is_teacher_owner(uuid) to authenticated;
grant execute on function is_teacher_owner(uuid) to service_role;

-- Enable RLS + policies. Admin policies are added in the next migration
-- once the is_admin() helper exists.
alter table teachers enable row level security;
alter table students enable row level security;
alter table discussions enable row level security;
alter table participations enable row level security;

create policy teachers_self_select on teachers
  for select using (auth_user_id = auth.uid());
create policy teachers_self_update on teachers
  for update using (auth_user_id = auth.uid());

create policy students_self_select on students
  for select using (is_teacher_owner(teacher_id));

create policy discussions_self_select on discussions
  for select using (is_teacher_owner(teacher_id));

create policy participations_self_select on participations
  for select using (
    exists (
      select 1 from discussions d
      where d.id = participations.discussion_id
        and is_teacher_owner(d.teacher_id)
    )
  );
