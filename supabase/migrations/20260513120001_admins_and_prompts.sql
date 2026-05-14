-- Admin layer + prompts library.
--
-- Mirrors AI Documenter's combined admins_and_system_prompts +
-- prompt_purpose_and_summary_seed migrations, collapsed into one since
-- Harkness v2 has the benefit of starting fresh.
--
-- Notes:
-- * admins is keyed on email (lower-cased), HAH-style. First-admin bootstrap
--   from INITIAL_ADMIN_EMAIL happens in the app layer (lib/auth/admin.ts).
-- * prompts has two orthogonal axes: scope (system|teacher) × purpose
--   (transcription for v2 launch; extensible). Transcription prompts must be
--   scope='system' — that's school-wide policy, not per-teacher.
-- * Only one transcription prompt seeded at scope='system', is_default=true.
--   The Phase C transcription job reads this row at the top of every call.

-- 1) admins -----------------------------------------------------------------
create table admins (
  email text primary key check (email = lower(email)),
  granted_by_email text,
  granted_at timestamptz not null default now(),
  active boolean not null default true
);

alter table admins enable row level security;

create or replace function is_admin()
returns boolean language sql security definer set search_path = public, auth as $$
  select exists (
    select 1 from admins a
    where a.active = true
      and a.email = lower((auth.jwt() ->> 'email'))
  );
$$;

revoke execute on function is_admin() from public;
revoke execute on function is_admin() from anon;
grant execute on function is_admin() to authenticated;
grant execute on function is_admin() to service_role;

-- Admins can read and modify the table. Bootstrap (first-admin insert) goes
-- through the service-role client in app code, which bypasses RLS.
create policy admins_select on admins
  for select using (is_admin());
create policy admins_modify on admins
  for all using (is_admin())
  with check (is_admin());

-- 2) prompts ---------------------------------------------------------------
create table prompts (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid references teachers(id) on delete cascade,
  scope text not null check (scope in ('system', 'teacher')),
  purpose text not null check (purpose in ('transcription')),
  label text not null,
  body text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- scope='system' rows must have teacher_id=null; scope='teacher' must have
  -- a teacher_id. Enforced at the DB level so app bugs can't desync.
  constraint prompts_scope_teacher_id_check check (
    (scope = 'system' and teacher_id is null) or
    (scope = 'teacher' and teacher_id is not null)
  ),
  -- Transcription is a school-wide policy decision, not a per-teacher knob.
  -- If we ever add a per-teacher purpose, expand this CHECK.
  constraint prompts_transcription_must_be_system check (
    purpose <> 'transcription' or scope = 'system'
  )
);

create unique index prompts_label_unique_system
  on prompts (purpose, label) where scope = 'system';
create unique index prompts_label_unique_teacher
  on prompts (teacher_id, purpose, label) where scope = 'teacher';

-- One default per (purpose, scope) for system rows; one default per
-- (purpose, teacher) for teacher rows. Uses a sentinel UUID inside coalesce
-- because Postgres doesn't allow `is null` in a unique-index expression.
create unique index prompts_one_default_system_per_purpose
  on prompts (purpose) where is_default and scope = 'system';
create unique index prompts_one_default_teacher_per_purpose
  on prompts (teacher_id, purpose) where is_default and scope = 'teacher';

create trigger prompts_set_updated_at before update on prompts
  for each row execute function set_updated_at();

alter table prompts enable row level security;

-- System prompts: everyone reads (teachers need them to know what's in
-- effect), admins write.
create policy prompts_select on prompts
  for select using (
    scope = 'system'
    or (scope = 'teacher' and is_teacher_owner(teacher_id))
  );

create policy prompts_modify on prompts
  for all using (
    (scope = 'system' and is_admin())
    or (scope = 'teacher' and teacher_id is not null and is_teacher_owner(teacher_id))
  )
  with check (
    (scope = 'system' and is_admin())
    or (scope = 'teacher' and teacher_id is not null and is_teacher_owner(teacher_id))
  );

-- 3) FK on discussions.transcription_prompt_id ----------------------------
alter table discussions
  add constraint discussions_transcription_prompt_id_fkey
  foreign key (transcription_prompt_id) references prompts(id)
  on delete restrict;

-- 4) Admins-can-read-everything overlay policies --------------------------
-- Layer admin SELECT visibility on top of the teacher-owner policies in the
-- initial schema. Admins don't *modify* teacher data through these — they
-- use the admin console which writes through service role for school-wide
-- operations.
create policy teachers_admin_select on teachers
  for select using (is_admin());
create policy students_admin_select on students
  for select using (is_admin());
create policy discussions_admin_select on discussions
  for select using (is_admin());
create policy participations_admin_select on participations
  for select using (is_admin());

-- 5) Seed the default transcription prompt -------------------------------
insert into prompts (label, scope, teacher_id, is_default, purpose, body)
values (
  'Default',
  'system',
  null,
  true,
  'transcription',
  $prompt$# Harkness Discussion Transcription

## Role
You produce a flowing, content-rich transcript of an audio recording of a Harkness-style classroom discussion at Episcopal High School. Your output is the source-of-record for the teacher's collective grade and for the AI-generated summary that follows.

## Output style
- **Do not attempt to identify individual speakers by name.** Use neutral handles like "one student", "another student", "a third student" if you need to attribute. Even if a name is spoken aloud in the recording, do not transcribe the name into a speaker label.
- Write a continuous record, not turn-by-turn dialogue. Paragraphs that follow the arc of the conversation — what was raised, where it went, who pushed back, where it landed.
- Quote short, illustrative phrases verbatim when they capture the substance of an idea. Don't quote everything.
- Note moments of silence, hesitation, or apparent confusion ("there was a pause before someone tried again"). These are part of the discussion's texture.
- If audio quality drops, note it briefly ("the next stretch is hard to make out") rather than guessing.

## Anonymization
- If any student's name is spoken in the audio, replace it in your output with the literal token `Student_xxxxxx` (six lowercase hex characters — pick any, the app will rewrite to the actual anon_token on the way back).
- Apply this to first names, last names, and full names. When in doubt, anonymize.
- Do not anonymize the teacher's name; mark it as `Teacher` if used.
- The text of the discussion itself — works being discussed, characters in those works, historical figures, etc. — is not PII and should appear verbatim.

## Length
Match the depth of the recording. A 50-minute Harkness discussion typically produces 2–4 paragraphs of flowing transcript per major topic. Don't pad. Don't summarize aggressively either — the teacher needs enough detail to grade the contribution shape of the conversation.

## What never to do
- Don't assign grades, comments, or feedback.
- Don't characterize individual students.
- Don't editorialize about the quality of the discussion.
- Don't include any speaker name from the audio in your output, even partially.$prompt$
);
