-- M6.22 Phase 0 — snapshot the roster onto each discussion row at
-- finalize time, so the Inngest worker can scrub against the roster that
-- was in place when the upload happened rather than the live (possibly
-- mutated) `course_rosters` JSONB.
--
-- Closes audit-pii-scrub.md Finding 8: "Roster snapshot loaded at
-- transcribe time, not upload time." A student removed from
-- `course_rosters` between finalize and worker run would otherwise have
-- their name leaked into the transcript + summary + outbound webhook.
--
-- `scrub_status` records the result of the scrub:
--   'ok'      — scrubber compiled + ran against the snapshot, output saved.
--   'roster_missing' — finalize-time roster was missing/empty; row should
--                      never have been written (kept as a sentinel for
--                      legacy rows that pre-date this migration).
--   'failed'  — scrubber threw at worker time; transcript was NOT written.
--
-- Pre-existing rows are backfilled to 'skipped' (sentinel meaning "no
-- snapshot column was populated when this row was created"). The Inngest
-- worker reads `roster_snapshot` first and falls back to the live
-- `course_rosters` table when the snapshot is null AND scrub_status is
-- 'skipped'.

alter table discussions
  add column roster_snapshot jsonb,
  add column scrub_status text not null default 'ok'
    check (scrub_status in ('ok', 'roster_missing', 'failed', 'skipped'));

-- Backfill: every pre-existing row predates the snapshot column. Mark them
-- 'skipped' so worker code can branch on the sentinel and read from the
-- live `course_rosters` table for those rows only.
update discussions set scrub_status = 'skipped' where roster_snapshot is null;

comment on column discussions.roster_snapshot is
  'JSON array of {canvas_user_id, name, email} captured at finalizeDiscussion '
  'time. Inngest worker scrubs against this snapshot, not the live roster.';
comment on column discussions.scrub_status is
  'Outcome of the boundary-scrub pass at worker time. ok | roster_missing | '
  'failed | skipped (legacy rows that pre-date the snapshot column).';
