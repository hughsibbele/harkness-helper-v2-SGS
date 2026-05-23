-- M7.5 — auto Drive doc + audio per discussion; first-ever HH→Canvas write.
--
-- Replaces today's on-demand SaveToDriveMenu (which stays as a manual
-- fallback) with an automatic Drive save fired by the Inngest worker
-- after Pass 1 + Pass 2 land. One Doc + one audio file per discussion,
-- flat in a per-teacher "Harkness Helper" folder (self-heals on 404 +
-- domain-shares to episcopalhighschool.org on create). The Doc body is
-- the scrubbed transcript + scrubbed summary; the audio file shares the
-- doc's base name so they sort together.
--
-- After the Drive doc lands, HH posts a draft Canvas comment to each
-- participating student's submission carrying the Drive link. This is
-- the FIRST time HH writes to Canvas at all; the per-teacher
-- `canvas_comment_enabled` boolean (default true) is the master switch
-- the M7.2 setup UI will surface later. Posting is per-class-granularity:
-- every participant gets the same draft comment.
--
-- All side effects are idempotent + state-fenced — the Inngest worker
-- skips the Drive step if `drive_doc_url` is already populated; skips
-- the Canvas step if `canvas_comment_posted_at` is already set.

alter table teachers
  add column drive_folder_id text,
  add column canvas_comment_enabled boolean not null default true;

alter table discussions
  add column drive_doc_id text,
  add column drive_doc_url text,
  add column drive_audio_id text,
  add column drive_audio_url text,
  add column canvas_comment_post_status text
    check (canvas_comment_post_status in ('ok', 'failed', 'skipped')),
  add column canvas_comment_posted_at timestamptz,
  add column canvas_comment_error text;

comment on column teachers.drive_folder_id is
  'M7.5 — Google Drive folder id for this teacher''s "Harkness Helper" '
  'folder. Auto-created on first save; self-healed on 404. Null on first '
  'use.';
comment on column teachers.canvas_comment_enabled is
  'M7.5 — when true, post a draft Canvas comment per participant on '
  'transcription complete (carries the Drive doc link). Default true; '
  'set false to disable HH''s Canvas writes entirely.';
comment on column discussions.drive_doc_url is
  'M7.5 — Drive webViewLink for the auto-created Doc containing the '
  'scrubbed transcript + summary. Set after the save-to-drive Inngest '
  'step succeeds; presence is the idempotency sentinel.';
comment on column discussions.canvas_comment_post_status is
  'M7.5 — outcome of the per-participant Canvas comment fan-out. ok = '
  'all comments posted; failed = at least one failed (see '
  'canvas_comment_error); skipped = canvas_comment_enabled is false or '
  'there are no participants.';
