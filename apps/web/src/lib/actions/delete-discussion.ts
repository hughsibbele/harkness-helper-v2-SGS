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

  // Delete the row first — cascades to participations via FK. If the
  // storage cleanup that follows fails, we have an orphan file but no
  // dangling row (better than the reverse, which would leave a phantom
  // discussion the user can't see audio for).
  const { error: deleteErr } = await admin
    .from("discussions")
    .delete()
    .eq("id", discussionId);
  if (deleteErr) return { ok: false, message: deleteErr.message };

  // Best-effort remove the audio file. Don't fail the operation on storage
  // errors — the row is already gone.
  await admin.storage
    .from(BUCKET)
    .remove([discussion.audio_url])
    .catch(() => {});

  revalidatePath("/dashboard");
  return { ok: true };
}
