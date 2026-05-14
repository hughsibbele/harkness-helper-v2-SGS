"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentAdminEmail } from "@/lib/auth/admin";
import type { SaveTranscriptionPromptResult } from "./system-prompts.types";

// Updates the body (and optionally the label) of an existing system
// transcription prompt. Phase A only edits the seeded Default; the migration
// guarantees exactly one such row exists.
//
// Service-role write — RLS would allow this too via the admin policy, but
// using service role keeps the call site uniform with other admin actions.
export async function saveTranscriptionPrompt(
  promptId: string,
  args: { label?: string; body?: string }
): Promise<SaveTranscriptionPromptResult> {
  const adminEmail = await getCurrentAdminEmail();
  if (!adminEmail) return { ok: false, message: "Admin only" };

  const updates: { label?: string; body?: string } = {};
  if (args.label !== undefined) {
    const label = args.label.trim();
    if (!label) return { ok: false, message: "Label can't be empty" };
    updates.label = label;
  }
  if (args.body !== undefined) {
    if (!args.body.trim()) return { ok: false, message: "Body can't be empty" };
    updates.body = args.body;
  }
  if (Object.keys(updates).length === 0) return { ok: true };

  const admin = createAdminDbClient();
  const { error } = await admin
    .from("prompts")
    .update(updates)
    .eq("id", promptId)
    .eq("scope", "system")
    .eq("purpose", "transcription");

  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        message: "A transcription prompt with that label already exists",
      };
    }
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/prompts");
  return { ok: true };
}
