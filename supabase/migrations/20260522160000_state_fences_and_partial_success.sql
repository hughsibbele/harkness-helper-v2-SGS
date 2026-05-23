-- M6.22 Phase 2 — partial-success columns + per-participation push tracking.
--
-- The state-fence work itself is application-side (every UPDATE that
-- touches `state` gains `.eq("state", expected)` so two concurrent
-- workers can't both flip the row). This migration adds the COLUMNS
-- needed to support the matching code changes:
--
-- 1. discussions.summary_status + summary_error — when Pass 2 fails after
--    Pass 1 succeeded, the row keeps state='transcribed' (transcript is
--    valuable on its own) and records the summary failure here. Previously
--    a Pass-2 throw fired onFailure → state='failed' → the transcript got
--    hidden behind a "Failed" badge in the dashboard, discarding work the
--    teacher could have used. Closes audit-discussion-state.md C5 and
--    the seams-audit's "Pass 1 success + Pass 2 failure" gap.
--
-- 2. participations.super_grader_post_{status,attempted_at,error} —
--    per-participant idempotent tracking of the SG webhook fan-out.
--    Previously the only record was on `discussions.super_grader_response`
--    as an aggregate JSONB blob with `failed: [{canvas_user_id, error}]`,
--    which made retrying just the failed participants impossible without
--    parsing the JSON. With per-row status, a future retry (Phase 6) can
--    filter participations.super_grader_post_status='failed' and re-POST
--    only those. Closes audit-discussion-state.md H6 (aggregate-only
--    push state) and audit-seams.md's partial-success-fan-out finding.
--
-- The aggregate `discussions.super_grader_post_status` stays (matches
-- the integration-contract envelope shape SG reads). Its value is now
-- derived: 'posted' iff every participation succeeded; 'error' iff any
-- failed; 'pending' before any attempt.

alter table discussions
  add column summary_status text
    check (summary_status in ('ok', 'failed')),
  add column summary_error text;

alter table participations
  add column super_grader_post_status text
    check (super_grader_post_status in ('ok', 'failed')),
  add column super_grader_post_attempted_at timestamptz,
  add column super_grader_post_error text;

comment on column discussions.summary_status is
  'M6.22 Phase 2 — Pass-2 (summary) outcome. ok | failed | NULL (not '
  'attempted yet). When failed, state stays ''transcribed'' so the '
  'transcript is still surfaced to the teacher.';
comment on column discussions.summary_error is
  'M6.22 Phase 2 — Pass-2 failure message (sliced to 1000 chars). Free-form.';
comment on column participations.super_grader_post_status is
  'M6.22 Phase 2 — per-participant outcome of the SG webhook fan-out. '
  'Enables a future retry to filter just the failed participants.';
comment on column participations.super_grader_post_attempted_at is
  'M6.22 Phase 2 — timestamp of the most recent POST attempt for this '
  'participation. Updated on every fan-out attempt regardless of outcome.';
comment on column participations.super_grader_post_error is
  'M6.22 Phase 2 — error message from the most recent failed POST. '
  'Sliced to 500 chars to bound JSONB / column-sniff exposure.';
