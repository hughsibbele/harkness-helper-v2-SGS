-- Canvas data cache: teacher's courses, assignments, and per-course roster.
--
-- All three tables are read by the UI under teacher-owner RLS and written by
-- the service-role admin client (the nightly cron + the manual "Refresh now"
-- button in the upload form). Writes never go through the user-context
-- supabase client — `revoke insert, update, delete` enforces this.
--
-- course_rosters is shaped as a single jsonb array per (teacher, course)
-- rather than a normalized table. Reads are always "give me the roster for
-- this course" (to feed the participant picker + the boundary scrubber);
-- we don't query individual students out of it.

-- 1) canvas_course_cache --------------------------------------------------
create table canvas_course_cache (
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_course_id text not null,
  name text not null,
  course_code text,
  workflow_state text not null,
  start_at timestamptz,
  end_at timestamptz,
  term_name text,
  term_start_at timestamptz,
  term_end_at timestamptz,
  last_synced_at timestamptz not null default now(),
  primary key (teacher_id, canvas_course_id)
);

alter table canvas_course_cache enable row level security;

create policy canvas_course_cache_self_select on canvas_course_cache
  for select using (is_teacher_owner(teacher_id) or is_admin());

revoke insert, update, delete on canvas_course_cache from authenticated;

-- 2) canvas_assignment_cache ----------------------------------------------
create table canvas_assignment_cache (
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_course_id text not null,
  canvas_assignment_id text not null,
  name text not null,
  description text,
  due_at timestamptz,
  points_possible numeric,
  workflow_state text not null,
  published boolean,
  last_synced_at timestamptz not null default now(),
  primary key (teacher_id, canvas_assignment_id)
);

create index canvas_assignment_cache_course_idx
  on canvas_assignment_cache (teacher_id, canvas_course_id);

alter table canvas_assignment_cache enable row level security;

create policy canvas_assignment_cache_self_select on canvas_assignment_cache
  for select using (is_teacher_owner(teacher_id) or is_admin());

revoke insert, update, delete on canvas_assignment_cache from authenticated;

-- 3) course_rosters -------------------------------------------------------
-- Powers the boundary scrubber (scrubSessionForGemini) and the participant
-- picker on the upload form. jsonb shape: [{canvas_user_id, name, email}, ...]
create table course_rosters (
  teacher_id uuid not null references teachers(id) on delete cascade,
  canvas_course_id text not null,
  students jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz not null default now(),
  primary key (teacher_id, canvas_course_id)
);

alter table course_rosters enable row level security;

create policy course_rosters_self_select on course_rosters
  for select using (is_teacher_owner(teacher_id) or is_admin());

revoke insert, update, delete on course_rosters from authenticated;
