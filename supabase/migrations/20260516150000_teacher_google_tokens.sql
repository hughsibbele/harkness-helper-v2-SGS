-- Google OAuth tokens per teacher for Drive + Docs API access.
--
-- Mirrors handwritten-assignment-helper's pattern (where the columns live
-- on the students table, since HH's actor is the student). HK's actor is
-- the teacher, so they go on teachers.
--
-- Tokens come from Supabase's session response after a sign-in that
-- requests drive.file + documents scopes with access_type=offline. The
-- callback handler persists provider_token + provider_refresh_token here;
-- the @google/lib helpers read them, refresh via googleapis SDK when
-- expired, and write the new pair back.

alter table teachers
  add column google_access_token text,
  add column google_refresh_token text,
  add column google_token_expires_at timestamptz;
