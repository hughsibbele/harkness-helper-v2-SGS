"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentAdminEmail } from "@/lib/auth/admin";
import type { SaveSystemPromptResult } from "./system-prompts.types";

// Updates the body (and optionally the label) of any existing system prompt.
// Admin-gated. The scope='system' filter on the WHERE clause is the security
// boundary — even if a non-admin somehow reached this action, the filter
// prevents editing of teacher-scoped prompts.
//
// M6.22 Phase 3c — optimistic-concurrency fence via `expected_updated_at`.
// Two admins editing the same prompt at the same time used to silently
// overwrite each other (last-write-wins, no surface). Now: caller passes
// the `updated_at` it most recently read; if the DB row's `updated_at`
// has moved past that, the UPDATE matches 0 rows and we return a typed
// 'conflict' result so the client can refresh and merge.

export async function saveSystemPrompt(
  promptId: string,
  args: {
    label?: string;
    body?: string;
    expected_updated_at: string;
  },
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
  const { data, error } = await admin
    .from("prompts")
    .update(updates)
    .eq("id", promptId)
    .eq("scope", "system")
    .eq("updated_at", args.expected_updated_at)
    .select("updated_at");

  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        message: "A prompt with that label already exists for this purpose",
      };
    }
    return { ok: false, message: error.message };
  }

  if (!data || data.length === 0) {
    // The fence rejected — either another writer beat us to it (most
    // common) or the prompt id no longer exists. Surface as conflict so
    // the client refreshes its `updated_at` baseline before retrying.
    return {
      ok: false,
      conflict: true,
      message:
        "Another save landed first. Reload the page to see the latest text before editing again.",
    };
  }

  revalidatePath("/admin/prompts");
  return { ok: true, updated_at: data[0].updated_at };
}
