-- Multiple discussions per Canvas assignment when split by section.
--
-- The original schema put `canvas_assignment_id UNIQUE` on discussions,
-- assuming one recording per assignment. But a teacher who teaches two
-- sections of the same English class records each section's Harkness
-- discussion against the same Canvas assignment — needs two rows.
--
-- New shape: composite unique on (canvas_assignment_id, canvas_section_id)
-- with NULLS NOT DISTINCT so the "no-section / cross-section" case can
-- only have one row per assignment either. The picker auto-snaps to the
-- single section in 1-section courses, so canvas_section_id is populated
-- in normal flows.

alter table discussions add column canvas_section_id text;

alter table discussions
  drop constraint discussions_canvas_assignment_id_key;

alter table discussions
  add constraint discussions_assignment_section_unique
  unique nulls not distinct (canvas_assignment_id, canvas_section_id);
