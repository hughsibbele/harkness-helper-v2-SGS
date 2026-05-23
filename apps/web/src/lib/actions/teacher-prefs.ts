"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";

// M7.2 — surface the canvas_comment_enabled toggle (added by M7.5) on
// /dashboard/setup. The teacher owns the per-account decision; admin-
// level override is not provided (the per-assignment override on the
// destination picker isn't a thing for HH today — every discussion
// goes to all participants of the picked assignment).

export type ToggleCanvasCommentResult =
  | { ok: true; enabled: boolean }
  | { ok: false; message: string };

export async function setCanvasCommentEnabled(
  enabled: boolean,
): Promise<ToggleCanvasCommentResult> {
  const teacher = await getCurrentTeacher();
  const admin = createAdminDbClient();
  const { error } = await admin
    .from("teachers")
    .update({ canvas_comment_enabled: enabled })
    .eq("id", teacher.id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/dashboard/setup");
  return { ok: true, enabled };
}
