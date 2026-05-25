import { createAdminDbClient } from "@harkness-helper/db/admin";
import type { HarknessEnvelope } from "./types";

const BUCKET = "discussion-audio";
const AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Compose the outbound envelope for one (canvas_user_id, canvas_assignment_id)
 * pair. Returns null when no transcribed discussion exists for that student
 * on that assignment — the caller turns that into a 404 (GET endpoint) or
 * a skip (outbound webhook).
 *
 * Transcript + summary are already roster-scrubbed at write time
 * (`scrubText` in transcribe-discussion's `scrub-transcript` /
 * `scrub-summary` steps), so we hand them out as-is.
 *
 * Audio is delivered as a 1-hour signed URL. Super-grader is expected to
 * re-fetch the envelope if the URL expires before the teacher plays it.
 */
export async function buildHarknessEnvelopeForCanvasIds(
  canvasUserId: string,
  canvasAssignmentId: string,
): Promise<HarknessEnvelope | null> {
  const admin = createAdminDbClient();

  // 1. All transcribed discussions for this Canvas assignment, newest first.
  //    A Canvas assignment can have multiple discussions when split across
  //    sections (unique on (canvas_assignment_id, canvas_section_id) nulls
  //    not distinct, per 20260516140000_discussion_per_section.sql).
  const { data: discussions, error: discussionsErr } = await admin
    .from("discussions")
    .select("id, audio_url, transcript, summary, drive_doc_url, updated_at")
    .eq("canvas_assignment_id", canvasAssignmentId)
    .in("state", ["transcribed", "posted_to_super_grader"])
    .order("updated_at", { ascending: false });
  if (discussionsErr) {
    throw new Error(`discussions lookup: ${discussionsErr.message}`);
  }
  if (!discussions || discussions.length === 0) return null;

  // 2. Of those, find the one this student participated in. A student is in
  //    exactly one section so at most one of the discussion ids will match
  //    — but iterating the newest-first list keeps the right tie-break if
  //    that assumption ever breaks (re-recording, manual data fix-ups).
  const discussionIds = discussions.map((d) => d.id);
  const { data: participations, error: participationsErr } = await admin
    .from("participations")
    .select(
      "discussion_id, students!inner ( canvas_user_id, email, anon_token )",
    )
    .in("discussion_id", discussionIds)
    .eq("students.canvas_user_id", canvasUserId);
  if (participationsErr) {
    throw new Error(`participations lookup: ${participationsErr.message}`);
  }

  type ParticipationRow = {
    discussion_id: string;
    students:
      | { canvas_user_id: string; email: string; anon_token: string }
      | { canvas_user_id: string; email: string; anon_token: string }[]
      | null;
  };
  const rows = (participations ?? []) as unknown as ParticipationRow[];
  const byDiscussion = new Map<string, ParticipationRow["students"]>();
  for (const r of rows) byDiscussion.set(r.discussion_id, r.students);

  const winner = discussions.find((d) => byDiscussion.has(d.id));
  if (!winner) return null;

  const studentField = byDiscussion.get(winner.id);
  const student = Array.isArray(studentField) ? studentField[0] : studentField;
  if (!student) return null;

  // 3. Sign the audio URL for delivery. Super-grader re-fetches the envelope
  //    when the URL expires; we don't notify on expiry.
  let signedAudioUrl: string | null = null;
  if (winner.audio_url) {
    const { data: signed } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(winner.audio_url, AUDIO_SIGNED_URL_TTL_SECONDS);
    signedAudioUrl = signed?.signedUrl ?? null;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  return {
    schema_version: 1,
    peer: "harkness",
    canvas_user_id: canvasUserId,
    canvas_assignment_id: canvasAssignmentId,
    anon_token: student.anon_token,
    completed_at: winner.updated_at,
    summary: {
      audio_url: signedAudioUrl,
      transcript: winner.transcript,
      suggested_summary: winner.summary,
      // M7.9 — Drive doc link (M7.5 sets drive_doc_url on the row when
      // save-to-drive lands). Optional — older transcribed rows that
      // pre-date M7.5 send the field as null.
      google_doc_url: winner.drive_doc_url ?? null,
    },
    links: {
      detail_url: `${appUrl}/dashboard`,
    },
  };
}
