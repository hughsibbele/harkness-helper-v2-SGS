"use client";

import { useState, useTransition } from "react";
import { setCanvasCommentEnabled } from "@/lib/actions/teacher-prefs";

export function CanvasCommentToggle({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function toggle() {
    const next = !enabled;
    setErrorMsg(null);
    // Optimistic flip — revert on failure.
    setEnabled(next);
    startTransition(async () => {
      const res = await setCanvasCommentEnabled(next);
      if (!res.ok) {
        setEnabled(!next);
        setErrorMsg(res.message);
      }
    });
  }

  return (
    <div className="space-y-2">
      <label className="inline-flex cursor-pointer items-center gap-3">
        <span className="relative inline-block h-5 w-9">
          <input
            type="checkbox"
            checked={enabled}
            onChange={toggle}
            disabled={isPending}
            className="peer absolute h-0 w-0 opacity-0"
          />
          <span
            aria-hidden
            className="block h-5 w-9 rounded-full bg-stone-300 transition-colors peer-checked:bg-dark-blue peer-disabled:opacity-50"
          />
          <span
            aria-hidden
            className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50"
          />
        </span>
        <span className="text-sm">
          {enabled ? (
            <>
              <span className="font-medium text-stone-900">
                Posting Canvas comments
              </span>{" "}
              <span className="text-cool-gray">
                — draft comment posts to each participant on transcribe
              </span>
            </>
          ) : (
            <>
              <span className="font-medium text-stone-900">
                Canvas comments disabled
              </span>{" "}
              <span className="text-cool-gray">
                — Drive doc still saves, no comment posts
              </span>
            </>
          )}
        </span>
      </label>
      {errorMsg && (
        <p className="text-xs text-red-700">Save failed: {errorMsg}</p>
      )}
    </div>
  );
}
