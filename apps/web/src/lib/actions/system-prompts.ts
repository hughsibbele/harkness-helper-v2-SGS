"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentAdminEmail } from "@/lib/auth/admin";
import type { SaveSystemPromptResult } from "./system-prompts.types";

// Updates the body (and optionally the label) of any existing system prompt.
// Admin-gated. The scope='system' filter on the WHERE clause is the security
// boundary — even if a non-admin somehow reached this action, the filter
// prevents editing of teacher-scoped prompts.

export async function saveSystemPrompt(
  promptId: string,
  args: { label?: string; body?: string },
): Promise<SaveSystemPromptResult> {
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
    .eq("scope", "system");

  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        message: "A prompt with that label already exists for this purpose",
      };
    }
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/prompts");
  return { ok: true };
}
