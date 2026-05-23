-- M6.22 Phase 0b — restrict teacher self-UPDATE to non-sensitive columns.
--
-- Closes audit-auth-rls.md MEDIUM: the prior `teachers_self_update` policy
-- (migration 20260513120000) allowed `FOR UPDATE USING (auth_user_id =
-- auth.uid())` with no column restriction. A signed-in teacher could call
-- PostgREST to rewrite their own `email`, `google_*_encrypted`,
-- `google_sub`, `auth_user_id`, etc. — defense-in-depth gap that the
-- audit flagged before any exploit.
--
-- Postgres doesn't have column-level RLS, but it DOES have column-level
-- GRANTs. The pattern:
--   1. REVOKE UPDATE on the table from `authenticated` (PostgREST's
--      user-token role).
--   2. GRANT UPDATE only on the explicitly-listed safe columns.
--   3. service_role (used by createAdminDbClient + the auth callback +
--      Inngest workers) bypasses both RLS AND column grants, so server-
--      side writes are unaffected.
--
-- Safe self-UPDATE columns: display_name, gemini_daily_cap. These are the
-- only columns a teacher might edit from a future profile UI. Everything
-- else (identity, token storage, audit timestamps) is server-only.

revoke update on table teachers from authenticated;

grant update (display_name, gemini_daily_cap) on table teachers to authenticated;
