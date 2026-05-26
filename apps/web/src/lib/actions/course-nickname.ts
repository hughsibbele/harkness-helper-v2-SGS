"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";

export type UpdateCourseNicknameResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Sets (or clears) the teacher-facing short_name on a cached Canvas course.
 * Uses the admin/service-role client because canvas_course_cache has
 * `REVOKE UPDATE FROM authenticated` — the RLS-authenticated client
 * cannot write to it.
 */
export async function updateCourseNickname(
  canvasCourseId: string,
  shortName: string,
): Promise<UpdateCourseNicknameResult> {
  const teacher = await getCurrentTeacher();
  const admin = createAdminDbClient();

  const trimmed = shortName.trim();
  const value = trimmed.length > 0 ? trimmed : null;

  const { error } = await admin
    .from("canvas_course_cache")
    .update({ short_name: value })
    .eq("teacher_id", teacher.id)
    .eq("canvas_course_id", canvasCourseId);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  return { ok: true };
}
