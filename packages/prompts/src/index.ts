// Prompt registry helpers. Two purposes today:
//   - 'transcription' — verbatim transcript from audio (Phase C pass 1)
//   - 'summary'       — narrative summary from a verbatim transcript (Phase C pass 2)
//
// "Active" = scope='system' AND purpose=... AND is_default=true. The partial
// unique index in 20260513120001_admins_and_prompts.sql guarantees at most
// one such row per (scope, purpose).

import { createAdminDbClient } from "@harkness-helper/db/admin";
import type { Tables } from "@harkness-helper/db";

export type Prompt = Tables<"prompts">;
export type TranscriptionPrompt = Prompt;
export type SummaryPrompt = Prompt;

async function getActiveSystemPrompt(
  purpose: "transcription" | "summary",
): Promise<Prompt> {
  const admin = createAdminDbClient();
  const { data, error } = await admin
    .from("prompts")
    .select("*")
    .eq("scope", "system")
    .eq("purpose", purpose)
    .eq("is_default", true)
    .single();
  if (error || !data) {
    throw new Error(
      `prompts: no active ${purpose} prompt found (${error?.message ?? "no row"}).`,
    );
  }
  return data;
}

export function getActiveTranscriptionPrompt(): Promise<TranscriptionPrompt> {
  return getActiveSystemPrompt("transcription");
}

export function getActiveSummaryPrompt(): Promise<SummaryPrompt> {
  return getActiveSystemPrompt("summary");
}
