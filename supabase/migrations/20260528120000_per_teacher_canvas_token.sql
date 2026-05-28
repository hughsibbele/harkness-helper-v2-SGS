-- M7.x — per-teacher Canvas API tokens.
--
-- Replaces the single-tenant CANVAS_API_TOKEN env-var model with a
-- per-teacher encrypted token on the teachers row. Aligns HH with the
-- four sibling apps (SG, OE, AID, HAH), which all store per-teacher
-- Canvas credentials.
--
-- Envelope: same AES-256-GCM shape as google_*_encrypted (Phase 0b /
-- 20260522130000). Reused key TEACHER_GTOKEN_ENC_KEY — Canvas tokens
-- and Google OAuth tokens are equally sensitive teacher-impersonation
-- material; one key, one rotation path.
--
-- canvas_host carries the normalized hostname (e.g.
-- "episcopalhighschool.instructure.com") so the same row knows where
-- to send the token. Today every HH teacher is on the EHS host, but
-- storing the host alongside the token avoids a future cross-school
-- migration and matches AID's shape.
--
-- Existing teachers will land with NULL on both columns and will be
-- prompted via /dashboard/setup to paste a token before sync/test/
-- post-comment work for them. The four call sites surface
-- "Canvas not connected" rather than 500ing.
--
-- service_role (admin client + the auth callback + Inngest workers)
-- bypasses RLS and column GRANTs, so the
-- 20260522130001_tighten_teachers_update_rls policy that restricts
-- authenticated UPDATEs to (display_name, gemini_daily_cap) is
-- intentionally NOT extended — connectCanvas writes via the admin
-- client, never directly from the user's session.

alter table teachers
  add column canvas_token_encrypted text,
  add column canvas_host text;

comment on column teachers.canvas_token_encrypted is
  'AES-256-GCM envelope of the teacher''s Canvas API token. '
  'base64(iv(12) || authtag(16) || ciphertext). Key: '
  'TEACHER_GTOKEN_ENC_KEY (shared with google_*_encrypted). Written via '
  'connectCanvas server action; never updatable from a user session.';
comment on column teachers.canvas_host is
  'Normalized Canvas host (e.g. "episcopalhighschool.instructure.com"). '
  'Populated alongside canvas_token_encrypted. Null when the teacher '
  'hasn''t connected Canvas yet.';
