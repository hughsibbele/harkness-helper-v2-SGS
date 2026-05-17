-- Section awareness on course_rosters.
--
-- Adds a sections jsonb array of {id, name} per (teacher, course). Students
-- in the existing `students` jsonb gain a `section_ids` field listing which
-- sections they're enrolled in (per-course; one student can be in multiple
-- sections of the same course, though it's uncommon).
--
-- Backfill is a no-op — existing rows get empty arrays. The next Canvas
-- sync populates real values.

alter table course_rosters
  add column sections jsonb not null default '[]'::jsonb;
