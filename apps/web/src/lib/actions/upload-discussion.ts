"use server";

import { revalidatePath } from "next/cache";
import { anonToken } from "@harkness-helper/anonymizer";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import type { UploadDiscussionResult } from "./upload-discussion.types";

const BUCKET = "discussion-audio";

function extensionForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "audio";
}

export async function uploadDiscussion(
  formData: FormData,
): Promise<UploadDiscussionResult> {
  const teacher = await getCurrentTeacher();

  const audio = formData.get("audio");
  const canvasCourseId = String(formData.get("canvas_course_id") ?? "").trim();
  const canvasAssignmentId = String(
    formData.get("canvas_assignment_id") ?? "",
  ).trim();
  const participantIds = formData
    .getAll("participant_id")
    .map((v) => String(v))
    .filter((v) => v.length > 0);

  if (!(audio instanceof File) || audio.size === 0) {
    return { ok: false, message: "Recording is empty or missing." };
  }
  if (!canvasCourseId) return { ok: false, message: "Course is required." };
  if (!canvasAssignmentId) {
    return { ok: false, message: "Assignment is required." };
  }

  const admin = createAdminDbClient();

  // Refuse a duplicate up front instead of orphaning a storage upload.
  const { data: existing } = await admin
    .from("discussions")
    .select("id")
    .eq("canvas_assignment_id", canvasAssignmentId)
    .maybeSingle();
  if (existing) {
    return {
      ok: false,
      message:
        "A recording is already linked to this assignment. Delete the existing discussion first to re-upload.",
    };
  }

  // Pull roster so we can hydrate students rows for the chosen participants.
  const { data: rosterRow, error: rosterErr } = await admin
    .from("course_rosters")
    .select("students")
    .eq("teacher_id", teacher.id)
    .eq("canvas_course_id", canvasCourseId)
    .maybeSingle();
  if (rosterErr) {
    return { ok: false, message: `roster lookup: ${rosterErr.message}` };
  }
  const roster: { canvas_user_id: string; name: string; email: string | null }[] =
    Array.isArray(rosterRow?.students)
      ? (rosterRow.students as { canvas_user_id: string; name: string; email: string | null }[])
      : [];
  const rosterById = new Map(roster.map((s) => [s.canvas_user_id, s]));

  // Storage: deterministic path keyed on canvas_assignment_id (unique → one
  // recording per assignment). Upload first so we have a stable audio_url
  // before inserting the discussion row.
  const ext = extensionForMime(audio.type);
  const storagePath = `${teacher.id}/${canvasAssignmentId}/recording.${ext}`;
  const { error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(storagePath, audio, {
      contentType: audio.type || "application/octet-stream",
      upsert: true,
    });
  if (uploadErr) {
    return { ok: false, message: `storage upload: ${uploadErr.message}` };
  }

  // Insert the discussion row. audio_url stores the storage path; signed
  // URLs are generated on demand at playback / transcription time.
  const today = new Date().toISOString().slice(0, 10);
  const { data: discussion, error: discussionErr } = await admin
    .from("discussions")
    .insert({
      teacher_id: teacher.id,
      canvas_assignment_id: canvasAssignmentId,
      canvas_course_id: canvasCourseId,
      recorded_at: today,
      audio_url: storagePath,
      state: "uploaded",
    })
    .select("id")
    .single();
  if (discussionErr || !discussion) {
    // Best-effort cleanup of the orphan file.
    await admin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    return {
      ok: false,
      message: `discussion insert: ${discussionErr?.message ?? "unknown error"}`,
    };
  }
  const discussionId = discussion.id;

  // Upsert students rows for the picked participants (each carries the
  // canonical anon_token computed via the shared anonymizer).
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

  revalidatePath("/dashboard");
  return { ok: true, discussionId };
}
