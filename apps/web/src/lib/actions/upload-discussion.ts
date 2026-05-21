"use server";

import { revalidatePath } from "next/cache";
import { anonToken } from "@harkness-helper/anonymizer";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { inngest } from "@/lib/inngest/client";
import type { FinalizeDiscussionResult } from "./upload-discussion.types";

const BUCKET = "discussion-audio";

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
  // list() on the parent prefix with the filename filter is cheap and
  // doesn't require additional permissions vs reading the object.
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
