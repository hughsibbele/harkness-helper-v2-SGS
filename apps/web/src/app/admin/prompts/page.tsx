import { createAdminDbClient } from "@harkness-helper/db/admin";
import type { Tables } from "@harkness-helper/db";
import { PromptEditor } from "./PromptEditor";

type Prompt = Tables<"prompts">;

// Display order + per-prompt description shown above the editor.
// Matches the order in which the prompts are seeded by migration.
const PROMPT_ORDER: Array<{
  purpose: Prompt["purpose"];
  description: string;
}> = [
  {
    purpose: "transcription",
    description:
      "Gemini receives this before the audio, then transcribes verbatim. Placeholder syntax: none — the audio follows in the same request.",
  },
  {
    purpose: "summary",
    description:
      "Runs after transcription with the verbatim transcript as input. Placeholder syntax: {transcript} (auto-filled), {grade} (currently always 'not yet assigned' — grading happens in super-grader).",
  },
  {
    purpose: "speaker_identification",
    description:
      "Maps Speaker labels to actual student names from a transcript excerpt. Placeholder syntax: {roster}, {transcript}. Seeded but NOT YET called by the current pipeline — present so edits land before the speaker-id flow is wired up.",
  },
  {
    purpose: "individual_feedback",
    description:
      "Per-student feedback (contribution summary + evaluative comment). Placeholder syntax: {student_name}, {grade}, {contributions}, {transcript}. Seeded but NOT YET called — placeholder for the per-student grading flow.",
  },
];

export default async function AdminPromptsPage() {
  const admin = createAdminDbClient();

  const { data: prompts, error } = await admin
    .from("prompts")
    .select("*")
    .eq("scope", "system")
    .eq("is_default", true);

  if (error || !prompts) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">System prompts</h1>
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          Failed to load prompts.
          {error && <div className="mt-1 text-xs">{error.message}</div>}
        </div>
      </div>
    );
  }

  const byPurpose = new Map(prompts.map((p) => [p.purpose, p]));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">System prompts</h1>
        <p className="mt-1 text-sm text-cool-gray">
          The system prompts the pipeline uses at each stage. Changes take
          effect on the next discussion processed — historical transcripts and
          summaries keep the prompt they were generated under.
        </p>
      </header>

      {PROMPT_ORDER.map(({ purpose, description }) => {
        const prompt = byPurpose.get(purpose);
        if (!prompt) {
          return (
            <section
              key={purpose}
              className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              No default prompt found for <code>{purpose}</code>. The
              migration may need to be re-run.
            </section>
          );
        }
        return (
          <PromptEditor key={purpose} prompt={prompt} description={description} />
        );
      })}
    </div>
  );
}
