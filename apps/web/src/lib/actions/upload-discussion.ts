"use server";

import { revalidatePath } from "next/cache";
import {
  anonToken,
  RosterMissingError,
  type AnonymizableStudent,
} from "@harkness-helper/anonymizer";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import type { Json } from "@harkness-helper/db";
import {
  getActiveSummaryPrompt,
  getActiveTranscriptionPrompt,
} from "@harkness-helper/prompts";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { inngest } from "@/lib/inngest/client";
import type { FinalizeDiscussionResult } from "./upload-discussion.types";

const BUCKET = "discussion-audio";

type RosterRowStudent = {
  canvas_user_id: string;
  name: string;
  email: string | null;
};

/**
 * Load the course-roster JSONB snapshot for (teacher, course) and reduce to
 * the email-bearing AnonymizableStudent list the scrubber consumes. Throws
 * `RosterMissingError` (fail-closed per M6.22 Phase 0) when the row is
 * missing OR every entry lacks an email — refusing to proceed with a
 * partial roster that would silently leave names unscrubbed.
 */
async function loadRosterSnapshot(
  admin: ReturnType<typeof createAdminDbClient>,
  teacherId: string,
  canvasCourseId: string,
): Promise<AnonymizableStudent[]> {
  const { data: rosterRow, error: rosterErr } = await admin
    .from("course_rosters")
    .select("students")
    .eq("teacher_id", teacherId)
    .eq("canvas_course_id", canvasCourseId)
    .maybeSingle();
  if (rosterErr) throw new Error(`roster lookup: ${rosterErr.message}`);
  if (!rosterRow) {
    throw new RosterMissingError(
      "missing_row",
      `No course_rosters row for course ${canvasCourseId}. Sync the roster from Canvas first.`,
    );
  }
  const rosterStudents = Array.isArray(rosterRow.students)
    ? (rosterRow.students as RosterRowStudent[])
    : [];
  if (rosterStudents.length === 0) {
    throw new RosterMissingError(
      "empty_students",
      `course_rosters row for course ${canvasCourseId} has no students. Re-sync from Canvas.`,
    );
  }
  const roster: AnonymizableStudent[] = rosterStudents
    .filter(
      (s): s is RosterRowStudent & { email: string } =>
        typeof s.email === "string" && s.email.trim().length > 0,
    )
    .map((s) => ({
      canvas_user_id: s.canvas_user_id,
      name: s.name,
      email: s.email,
    }));
  if (roster.length === 0) {
    throw new RosterMissingError(
      "no_email_students",
      `course_rosters row for course ${canvasCourseId} has ${rosterStudents.length} students but none have an email. ` +
        "Canvas may be hiding emails — re-sync with a token that has student-email read scope.",
    );
  }
  return roster;
}

export async function finalizeDiscussion(params: {
  storagePath: string;
  canvasCourseId: string;
  canvasAssignmentId: string;
  canvasSectionId: string | null;
  participantIds: string[];
}): Promise<FinalizeDiscussionResult> {
  const teacher = await getCurrentTeacher();

  const canvasCourseId = params.canvasCourseId.trim();
  const canvasAssignmentId = params.canvasAssignmentId.trim();
  const canvasSectionId =
    params.canvasSectionId && params.canvasSectionId.trim().length > 0
      ? params.canvasSectionId.trim()
      : null;
  const storagePath = params.storagePath.trim();
  const participantIds = params.participantIds
    .map((v) => String(v))
    .filter((v) => v.length > 0);

  if (!canvasCourseId) return { ok: false, message: "Course is required." };
  if (!canvasAssignmentId) {
    return { ok: false, message: "Assignment is required." };
  }

  // The signed upload URL was issued for a teacher-scoped path. Reject any
  // storagePath that doesn't start with this teacher's id — defense against
  // a tampered client trying to claim someone else's upload.
  if (!storagePath.startsWith(`${teacher.id}/`)) {
    return { ok: false, message: "storage path does not belong to teacher" };
  }

  const admin = createAdminDbClient();

  // Confirm the upload actually landed in storage before we create the row.
  const lastSlash = storagePath.lastIndexOf("/");
  const prefix = storagePath.slice(0, lastSlash);
  const filename = storagePath.slice(lastSlash + 1);
  const { data: existing, error: listErr } = await admin.storage
    .from(BUCKET)
    .list(prefix, { search: filename });
  if (listErr) {
    return { ok: false, message: `storage check: ${listErr.message}` };
  }
  const uploaded = existing?.find((o) => o.name === filename);
  if (!uploaded) {
    return {
      ok: false,
      message: "audio file was not found at the prepared storage path",
    };
  }

  // Fail-closed roster fetch. If the roster is missing/empty/has no emails,
  // refuse to create the discussion row at all — the Inngest worker would
  // otherwise scrub against an empty roster and write Gemini output
  // verbatim. M6.22 Phase 0.
  let roster: AnonymizableStudent[];
  try {
    roster = await loadRosterSnapshot(admin, teacher.id, canvasCourseId);
  } catch (err) {
    if (err instanceof RosterMissingError) {
      return {
        ok: false,
        message: `Cannot record this discussion: ${err.message}`,
      };
    }
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const rosterById = new Map(roster.map((s) => [s.canvas_user_id, s]));

  // Fail-closed participant validation. Every picked participantId must
  // resolve to a roster entry with a non-empty email — otherwise the
  // student would have no participation row (silent drop), and any spoken
  // utterance of their name in the transcript would never make it into
  // the scrubber's compiled roster (no email = no anon_token = no scrub
  // entry). H4 fix: surface as "re-sync, then re-pick" rather than ship a
  // partial set. M6.22 Phase 1.
  const droppedParticipants = participantIds.filter(
    (cuid) => !rosterById.get(cuid)?.email,
  );
  if (droppedParticipants.length > 0) {
    return {
      ok: false,
      message:
        `${droppedParticipants.length} selected participant(s) aren't in the synced roster ` +
        `or don't have an email recorded. Re-sync this course from Canvas and re-pick, or ` +
        `un-pick the affected students. Missing canvas_user_ids: ` +
        droppedParticipants.slice(0, 10).join(", ") +
        (droppedParticipants.length > 10
          ? ` (+${droppedParticipants.length - 10} more)`
          : ""),
    };
  }

  // M6.22 Phase 1 — snapshot the prompt bodies at finalize time so the
  // Inngest worker can't drift away from what was active when the
  // recording was uploaded. Closes audit-discussion-state.md C2.
  let transcriptionPrompt, summaryPrompt;
  try {
    [transcriptionPrompt, summaryPrompt] = await Promise.all([
      getActiveTranscriptionPrompt(),
      getActiveSummaryPrompt(),
    ]);
  } catch (err) {
    return {
      ok: false,
      message: `prompts lookup: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: discussion, error: discussionErr } = await admin
    .from("discussions")
    .insert({
      teacher_id: teacher.id,
      canvas_assignment_id: canvasAssignmentId,
      canvas_course_id: canvasCourseId,
      canvas_section_id: canvasSectionId,
      recorded_at: today,
      audio_url: storagePath,
      state: "uploaded",
      roster_snapshot: roster as unknown as Json,
      scrub_status: "ok",
      transcription_prompt_id: transcriptionPrompt.id,
      summary_prompt_id: summaryPrompt.id,
      transcription_prompt_body_snapshot: transcriptionPrompt.body,
      summary_prompt_body_snapshot: summaryPrompt.body,
    })
    .select("id")
    .single();
  if (discussionErr || !discussion) {
    // The unique constraint may have raced with another upload; leave the
    // orphan blob in place — retention sweep handles it.
    return {
      ok: false,
      message: `discussion insert: ${discussionErr?.message ?? "unknown error"}`,
    };
  }
  const discussionId = discussion.id;

  if (participantIds.length > 0) {
    const studentRows = participantIds
      .map((cuid) => {
        const r = rosterById.get(cuid);
        if (!r || !r.email) return null;
        return {
          teacher_id: teacher.id,
          canvas_user_id: cuid,
          canvas_course_id: canvasCourseId,
          email: r.email.toLowerCase(),
          display_name: r.name,
          anon_token: anonToken(cuid, r.email),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (studentRows.length > 0) {
      const { data: insertedStudents, error: studentsErr } = await admin
        .from("students")
        .upsert(studentRows, {
          onConflict: "teacher_id,canvas_user_id,canvas_course_id",
        })
        .select("id, canvas_user_id");
      if (studentsErr || !insertedStudents) {
        return {
          ok: false,
          message: `students upsert: ${studentsErr?.message ?? "unknown"}`,
        };
      }

      const { error: participationsErr } = await admin
        .from("participations")
        .insert(
          insertedStudents.map((s) => ({
            discussion_id: discussionId,
            student_id: s.id,
          })),
        );
      if (participationsErr) {
        return {
          ok: false,
          message: `participations insert: ${participationsErr.message}`,
        };
      }
    }
  }

  try {
    await inngest.send({
      name: "discussion.uploaded",
      data: { discussionId },
    });
  } catch {
    // Don't block the upload's success on a missing Inngest dev server.
  }

  revalidatePath("/dashboard");
  return { ok: true, discussionId };
}
