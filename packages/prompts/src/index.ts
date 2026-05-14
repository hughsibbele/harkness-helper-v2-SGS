// Prompt registry helpers. Phase A only exposes the read path for the active
// transcription prompt — Phase C uses this to load the prompt body at the
// top of every Gemini audio call.
//
// "Active" = scope='system' AND purpose='transcription' AND is_default=true.
// The migration's partial unique index guarantees there's exactly one such
// row at any time.

import { createAdminDbClient } from "@harkness-helper/db/admin";
import type { Tables } from "@harkness-helper/db";

export type TranscriptionPrompt = Tables<"prompts">;

export async function getActiveTranscriptionPrompt(): Promise<TranscriptionPrompt> {
  const admin = createAdminDbClient();
  const { data, error } = await admin
    .from("prompts")
    .select("*")
    .eq("scope", "system")
    .eq("purpose", "transcription")
    .eq("is_default", true)
    .single();
  if (error || !data) {
    throw new Error(
      `prompts: no active transcription prompt found (${error?.message ?? "no row"}). ` +
        "Run the 20260513120001_admins_and_prompts.sql migration."
    );
  }
  return data;
}
