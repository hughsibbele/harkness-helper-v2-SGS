"use client";

import { useRef, useState, useTransition } from "react";
import type { Tables } from "@harkness-helper/db";
import { saveSystemPrompt } from "@/lib/actions/system-prompts";
import { useAutoSaveDispatch } from "@/components/auto-save/context";
import { useAutoSaveForm } from "@/components/auto-save/useAutoSaveForm";

type Prompt = Tables<"prompts">;

export function PromptEditor({
  prompt,
  description,
}: {
  prompt: Prompt;
  description: string;
}) {
  const [updatedAt, setUpdatedAt] = useState(prompt.updated_at);
  const dispatch = useAutoSaveDispatch();
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function save() {
    const label = labelRef.current?.value ?? "";
    const body = bodyRef.current?.value ?? "";
    const labelChanged = label !== labelRef.current?.defaultValue;
    const bodyChanged = body !== bodyRef.current?.defaultValue;
    if (!labelChanged && !bodyChanged) return;

    dispatch({ kind: "saving" });
    startTransition(async () => {
      const r = await saveSystemPrompt(prompt.id, {
        label: labelChanged ? label : undefined,
        body: bodyChanged ? body : undefined,
      });
      if (r.ok) {
        const nowIso = new Date().toISOString();
        setUpdatedAt(nowIso);
        // Re-baseline the inputs so isFormDirty stops reporting as
        // dirty after a clean save. React doesn't update DOM
        // defaultValue/defaultChecked on re-render.
        if (labelRef.current) labelRef.current.defaultValue = label;
        if (bodyRef.current) bodyRef.current.defaultValue = body;
        dispatch({ kind: "saved", at: Date.now() });
      } else {
        dispatch({ kind: "error", msg: r.message });
      }
    });
  }

  useAutoSaveForm({ formRef, save, freshnessKey: prompt.updated_at });

  return (
    <section className="space-y-4 rounded-sm border border-stone-200 bg-white p-5 shadow-sm">
      <header>
        <h2 className="text-base font-semibold tracking-tight text-ink">
          {purposeTitle(prompt.purpose)}
        </h2>
        <p className="mt-0.5 text-xs italic text-cool-gray">{description}</p>
      </header>

      <form
        ref={formRef}
        onSubmit={(e) => e.preventDefault()}
        className="space-y-4"
      >
        <div>
          <label className="ehs-eyebrow mb-1.5 block text-cool-gray">
            Label
          </label>
          <input
            ref={labelRef}
            type="text"
            name="label"
            defaultValue={prompt.label}
            spellCheck={false}
            className="w-full rounded-sm border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-dark-blue focus:outline-none"
          />
        </div>

        <div>
          <label className="ehs-eyebrow mb-1.5 block text-cool-gray">
            Prompt body
          </label>
          <textarea
            ref={bodyRef}
            name="body"
            defaultValue={prompt.body}
            rows={20}
            spellCheck={false}
            className="w-full resize-y rounded-sm border border-stone-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed shadow-inner focus:border-dark-blue focus:outline-none"
          />
        </div>
      </form>

      <p className="text-[11px] italic text-cool-gray">
        Last edited {formatDate(updatedAt)}
      </p>
    </section>
  );
}

function purposeTitle(purpose: string): string {
  switch (purpose) {
    case "transcription":
      return "Transcription";
    case "summary":
      return "Group feedback (summary + evaluative comment)";
    case "speaker_identification":
      return "Speaker identification";
    case "individual_feedback":
      return "Individual feedback";
    default:
      return purpose;
  }
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
