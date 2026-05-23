-- M6.22 Phase 1 — snapshot the transcription + summary prompt BODIES onto
-- each discussion row at finalize time.
--
-- Closes audit-discussion-state.md C2 ("prompt body is read live at Inngest
-- job time, not snapshotted at upload time"). The Inngest worker previously
-- called getActiveTranscriptionPrompt() + getActiveSummaryPrompt() at job-
-- start time — fresh SELECTs against the prompts table. If an admin auto-
-- saves the transcription prompt (debounced 800ms) between
-- finalizeDiscussion and the worker, the worker reads the EDITED body
-- against the SAME audio. Pass 1 + Pass 2 could even run against different
-- bodies if a save lands between the steps.
--
-- The FK columns `transcription_prompt_id` and `summary_prompt_id` already
-- existed and pin which prompt ROW the discussion used, but NOT what the
-- BODY said at finalize. Both FKs are already ON DELETE RESTRICT (per
-- 20260513120001_admins_and_prompts.sql:108-112 and
-- 20260516160000_two_pass_transcript_summary.sql:20), so admins can't
-- delete a prompt that has live discussions — but they CAN edit the body
-- via /admin/prompts, and the live-read pattern silently uses the new
-- body on every retry.
--
-- New columns:
--   - transcription_prompt_body_snapshot text — verbatim body at finalize
--   - summary_prompt_body_snapshot text       — verbatim body at finalize
--
-- Worker contract:
--   - If transcription_prompt_body_snapshot IS NOT NULL → use it. Always.
--     Pass 1 + Pass 2 share the same snapshot, set at the same finalize.
--   - If NULL (legacy row pre-Phase-1) → fall back to getActive*Prompt()
--     live read, same as before. Backward-compat path stays.
--
-- This is the prompt half of the snapshot story; the roster half landed
-- in 20260522120000 (M6.22 Phase 0).

alter table discussions
  add column transcription_prompt_body_snapshot text,
  add column summary_prompt_body_snapshot text;

comment on column discussions.transcription_prompt_body_snapshot is
  'Verbatim body of the transcription system prompt at finalize time. '
  'Inngest worker reads this first; falls back to live read for legacy '
  'rows where this is NULL. M6.22 Phase 1.';
comment on column discussions.summary_prompt_body_snapshot is
  'Verbatim body of the summary system prompt at finalize time. Same '
  'snapshot-first / live-fallback contract as transcription_prompt_body_'
  'snapshot. M6.22 Phase 1.';
