-- Follow-up to M6.22 Phase 0b: drop the legacy plaintext Google OAuth
-- token columns from `teachers`.
--
-- DO NOT APPLY until the operator has:
--   1. Set `TEACHER_GTOKEN_ENC_KEY` in Vercel + apps/web/.env.local.
--   2. Run `APP=hh node scripts/backfill-teacher-gtoken-encryption.mjs`
--      (suite root) and confirmed the post-run sanity check reports
--      "✅ clean — safe to apply the drop-plaintext follow-up migration."
--   3. Verified manually via:
--        select count(*) from teachers
--          where google_access_token is not null
--             or google_refresh_token is not null;
--      → 0.
--
-- Step 2's idempotent — the script re-encrypts any row that still has
-- a plaintext value AND a null encrypted value. Step 3 is the audit
-- trail check.
--
-- Once dropped, `lib/google/auth.ts` no longer falls back to the
-- plaintext columns — every teacher row must have valid encrypted
-- tokens or the auth flow throws `missing_refresh_token`. The
-- fallback-removal is a separate code commit landing alongside this
-- migration's apply.

alter table teachers
  drop column google_access_token,
  drop column google_refresh_token;

comment on table teachers is
  'Google OAuth tokens stored encrypted-only on google_*_encrypted '
  '(M6.22 Phase 0b + 2026-05-24 plaintext-column drop). Decrypt via '
  'lib/google/auth.ts → readEncryptedOrLegacy now reads only the '
  'encrypted columns.';
