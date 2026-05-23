"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import type { DeleteDiscussionResult } from "./delete-discussion.types";

const BUCKET = "discussion-audio";

export async function deleteDiscussion(
  discussionId: string,
): Promise<DeleteDiscussionResult> {
  const teacher = await getCurrentTeacher();
  const admin = createAdminDbClient();

  // Verify ownership + capture audio path before deleting the row.
  const { data: discussion, error: lookupErr } = await admin
    .from("discussions")
    .select("id, teacher_id, audio_url")
    .eq("id", discussionId)
    .maybeSingle();
  if (lookupErr) return { ok: false, message: lookupErr.message };
  if (!discussion) return { ok: false, message: "Discussion not found." };
  if (discussion.teacher_id !== teacher.id) {
    return { ok: false, message: "Not authorized." };
  }

  // M6.22 Phase 2 — idempotent + ownership-fenced delete. The `.eq("id",
  // ...).eq("teacher_id", ...)` doubles as a fence: a second concurrent
  // click sees 0 rows affected (some other actor already deleted the
  // row), and a tampered call from a teacher who doesn't own this row
  // fails the teacher_id check at the DB layer (defense in depth on top
  // of the teacher-check above). Returning `.select("id")` lets us
  // distinguish "deleted just now" from "already gone" — both are ok:true
  // (idempotent UX) but the latter doesn't try to delete the audio twice.
  const { data: deletedRows, error: deleteErr } = await admin
    .from("discussions")
    .delete()
    .eq("id", discussionId)
    .eq("teacher_id", teacher.id)
    .select("id");
  if (deleteErr) return { ok: false, message: deleteErr.message };

  if (deletedRows && deletedRows.length > 0) {
    // Best-effort remove the audio file. Don't fail the operation on storage
    // errors — the row is already gone.
    await admin.storage
      .from(BUCKET)
      .remove([discussion.audio_url])
      .catch(() => {});
  }

  revalidatePath("/dashboard");
  return { ok: true };
}
