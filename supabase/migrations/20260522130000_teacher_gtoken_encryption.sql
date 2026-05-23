-- M6.22 Phase 0b — encrypt teacher Google OAuth tokens at rest.
--
-- Closes audit-auth-rls.md H1: plaintext `teachers.google_refresh_token` on
-- a row readable by any admin via the `teachers_admin_select` RLS overlay
-- is durable Drive-impersonation material. A `pg_dump`, backup leak, or
-- curious admin = the ability to act as any teacher against Google Drive.
--
-- Shape mirrors HAH's `STUDENT_GDRIVE_TOKEN_ENC_KEY` migration (HAH `9a267bd`,
-- migration 026):
--   - Add nullable `*_encrypted` text columns alongside the legacy plaintext.
--   - Application code writes encrypted-first on every callback + refresh,
--     nulls the plaintext on the same write.
--   - Reads prefer encrypted; fall back to legacy plaintext for un-backfilled
--     rows.
--   - A follow-up migration drops the plaintext columns once the operator
--     confirms backfill is complete and `google_access_token IS NULL AND
--     google_refresh_token IS NULL` holds across the whole table.
--
-- Key source: TEACHER_GTOKEN_ENC_KEY env var. Generate with
-- `openssl rand -base64 32`. Set in Vercel (production + preview +
-- development scopes) and `apps/web/.env.local`. Until the operator does
-- this, writes throw and the auth callback surfaces an error — reads
-- continue to work via the plaintext fallback so existing teachers stay
-- functional.

alter table teachers
  add column google_access_token_encrypted text,
  add column google_refresh_token_encrypted text;

comment on column teachers.google_access_token_encrypted is
  'AES-256-GCM envelope of Google OAuth access_token. base64(iv(12) || '
  'ciphertext || authtag(16)). Key: TEACHER_GTOKEN_ENC_KEY. M6.22 Phase 0b.';
comment on column teachers.google_refresh_token_encrypted is
  'AES-256-GCM envelope of Google OAuth refresh_token. Same shape as '
  'google_access_token_encrypted. M6.22 Phase 0b.';
