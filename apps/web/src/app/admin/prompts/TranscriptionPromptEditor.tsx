"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@harkness-helper/db";
import { saveTranscriptionPrompt } from "@/lib/actions/system-prompts";

type Prompt = Tables<"prompts">;

export function TranscriptionPromptEditor({ prompt }: { prompt: Prompt }) {
  const [label, setLabel] = useState(prompt.label);
  const [body, setBody] = useState(prompt.body);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<
    | null
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
  >(null);

  const dirty = label !== prompt.label || body !== prompt.body;

  function onSave() {
    setFeedback(null);
    startTransition(async () => {
      const r = await saveTranscriptionPrompt(prompt.id, {
        label: label !== prompt.label ? label : undefined,
        body: body !== prompt.body ? body : undefined,
      });
      if (r.ok) {
        setFeedback({ kind: "ok", message: "Saved." });
      } else {
        setFeedback({ kind: "error", message: r.message });
      }
    });
  }

  function onDiscard() {
    setLabel(prompt.label);
    setBody(prompt.body);
    setFeedback(null);
  }

  return (
    <section className="space-y-4 rounded-sm border border-stone-200 bg-white p-5 shadow-sm">
      <div>
        <label className="ehs-eyebrow mb-1.5 block text-cool-gray">
          Label
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          spellCheck={false}
          className="w-full rounded-sm border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-dark-blue focus:outline-none"
        />
      </div>

      <div>
        <label className="ehs-eyebrow mb-1.5 block text-cool-gray">
          Prompt body
        </label>
        <p className="mb-1.5 text-xs italic text-cool-gray">
          Markdown. Gemini receives this verbatim before the audio. The audio
          itself follows in the same request.
        </p>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={28}
          spellCheck={false}
          className="w-full resize-y rounded-sm border border-stone-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed shadow-inner focus:border-dark-blue focus:outline-none"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || pending}
          className="rounded-sm bg-dark-blue px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-dark-blue-dark disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={!dirty || pending}
          className="rounded-sm px-2 py-1 text-sm text-cool-gray hover:bg-stone-100 disabled:opacity-50"
        >
          Discard changes
        </button>
        {feedback && (
          <span
            className={`text-xs ${
              feedback.kind === "ok" ? "text-emerald-700" : "text-red-700"
            }`}
          >
            {feedback.message}
          </span>
        )}
        <span className="ml-auto text-[11px] italic text-cool-gray">
          Last edited {formatDate(prompt.updated_at)}
        </span>
      </div>
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
