-- M6.22 Phase 0c — add `archived` to discussion_state enum.
--
-- Used by /api/cron/sweep-discussions to mark stuck `uploaded`/`transcribing`
-- rows whose audio blob has been removed (Phase 0c retention sweep). The
-- `archived` value is also the gate for the hard-delete pass — only rows in
-- terminal-state ('transcribed','posted_to_super_grader','failed','archived')
-- older than 13 months are eligible for hard delete.
--
-- Enum ordering: uploaded → transcribing → transcribed → posted_to_super_grader
-- → failed (Gemini/save error, retryable) → archived (sweep-detected stuck or
-- past-grace, terminal-stuck).
--
-- Standalone migration (no DDL on tables in the same file) — Postgres 12+
-- supports `ALTER TYPE ... ADD VALUE` inside a transaction, but the new
-- value cannot be USED in the same transaction. Keeping this isolated
-- mirrors AID's `20260521150000_phase3_archived_state.sql` precedent and
-- avoids the future-foot-gun.

alter type discussion_state add value if not exists 'archived' after 'failed';

comment on type discussion_state is
  'Lifecycle: uploaded → transcribing → transcribed → posted_to_super_grader '
  '(terminal success); failed (Gemini/save error, retryable); archived '
  '(M6.22 Phase 0c: sweep-detected stuck or past-grace, terminal-stuck).';
