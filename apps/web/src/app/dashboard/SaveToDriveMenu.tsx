"use client";

import { useState, useTransition } from "react";
import {
  saveAllToDrive,
  saveAudioToDrive,
  saveSummaryToDrive,
  saveTranscriptToDrive,
} from "@/lib/actions/save-to-drive";
import type { SaveToDriveResult } from "@/lib/actions/save-to-drive.types";

export function SaveToDriveMenu({
  discussionId,
  hasAudio,
  hasTranscript,
  hasSummary,
}: {
  discussionId: string;
  hasAudio: boolean;
  hasTranscript: boolean;
  hasSummary: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SaveToDriveResult | null>(null);

  function run(
    action: (id: string) => Promise<SaveToDriveResult>,
  ): void {
    setResult(null);
    startTransition(async () => {
      const r = await action(discussionId);
      setResult(r);
      if (r.ok) setOpen(false);
    });
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Save to Drive"
        className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-medium text-cool-gray hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
      >
        <DriveIcon />
        Drive
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-1 w-48 rounded-md border border-stone-200 bg-white py-1 text-xs shadow-md">
          <MenuItem
            disabled={!hasAudio || pending}
            onClick={() => run(saveAudioToDrive)}
            title={!hasAudio ? "No audio yet" : "Save audio file"}
          >
            Save audio
          </MenuItem>
          <MenuItem
            disabled={!hasTranscript || pending}
            onClick={() => run(saveTranscriptToDrive)}
            title={!hasTranscript ? "No transcript yet" : "Save verbatim transcript as Doc"}
          >
            Save transcript
          </MenuItem>
          <MenuItem
            disabled={!hasSummary || pending}
            onClick={() => run(saveSummaryToDrive)}
            title={!hasSummary ? "No summary yet" : "Save narrative summary as Doc"}
          >
            Save summary
          </MenuItem>
          <MenuItem
            disabled={!hasAudio || pending}
            onClick={() => run(saveAllToDrive)}
            title={
              !hasAudio
                ? "Need audio to save"
                : "Create a folder and save all available items"
            }
          >
            Save all to folder
          </MenuItem>
        </div>
      )}

      {pending && (
        <span className="ml-2 text-xs text-cool-gray">Saving…</span>
      )}

      {result && result.ok && (
        <span className="ml-2 inline-flex items-center gap-1 text-xs text-emerald-700">
          Saved
          {result.links.map((l, i) => (
            <a
              key={i}
              href={l.webViewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {l.kind}
            </a>
          ))}
        </span>
      )}

      {result && !result.ok && (
        <span className="ml-2 text-xs text-red-700" title={result.message}>
          {result.message}
        </span>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="block w-full px-3 py-1.5 text-left text-ink hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function DriveIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 1.5h4l4.5 8L12 14H4l-2.5-4.5z" />
      <path d="M6 1.5L1.5 9.5" />
      <path d="M10 1.5l4.5 8" />
      <path d="M4 14l3-5h7" />
    </svg>
  );
}
