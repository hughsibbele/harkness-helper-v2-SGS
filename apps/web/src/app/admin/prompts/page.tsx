import { createAdminDbClient } from "@harkness-helper/db/admin";
import { TranscriptionPromptEditor } from "./TranscriptionPromptEditor";

// Single-prompt editor. The migration seeds exactly one
// (scope='system', purpose='transcription', is_default=true) row, and the
// unique index keeps it that way. If a future admin wants alternative
// transcription prompts, this page grows a list/picker — but for v2 launch,
// one editor screen.
export default async function AdminPromptsPage() {
  const admin = createAdminDbClient();

  const { data: prompt, error } = await admin
    .from("prompts")
    .select("*")
    .eq("scope", "system")
    .eq("purpose", "transcription")
    .eq("is_default", true)
    .single();

  if (error || !prompt) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">
          Transcription prompt
        </h1>
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          No default transcription prompt found. Run the
          {" "}<code>20260513120001_admins_and_prompts.sql</code> migration.
          {error && <div className="mt-1 text-xs">{error.message}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">
          Transcription prompt
        </h1>
        <p className="mt-1 text-sm text-cool-gray">
          The system prompt Gemini receives for every Harkness audio
          transcription. Changes take effect on the next discussion processed
          — historical transcripts keep the prompt they were generated under.
        </p>
      </header>

      <TranscriptionPromptEditor prompt={prompt} />
    </div>
  );
}
