-- discussion-audio storage bucket for uploaded classroom recordings.
--
-- Private: audio is sensitive (student voices + identified Canvas assignments).
-- Reads happen via signed URLs generated server-side (for playback in the
-- teacher dashboard and for the Phase C Gemini transcription job). Writes
-- happen via the service-role client in the upload server action.
--
-- No RLS policies on storage.objects for this bucket: service-role bypasses
-- RLS for writes, and signed URLs bypass RLS for reads (the signed token is
-- the authorization).
--
-- Size limit 100MB covers a 60-minute Harkness recording at typical bitrates:
-- webm/opus @ 64kbps → ~30MB, mp4/aac @ 128kbps → ~60MB.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'discussion-audio',
  'discussion-audio',
  false,
  104857600,
  array['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav']
);
