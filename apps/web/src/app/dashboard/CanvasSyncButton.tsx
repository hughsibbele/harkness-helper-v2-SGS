"use client";

import { useState, useTransition } from "react";
import { syncCanvasCache } from "@/lib/actions/canvas-sync";
import type { CanvasSyncResult } from "@/lib/actions/canvas-sync.types";

export function CanvasSyncButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CanvasSyncResult | null>(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      const r = await syncCanvasCache();
      setResult(r);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-stone-100 disabled:opacity-50"
      >
        {pending ? "Syncing…" : "Refresh from Canvas"}
      </button>
      {result && result.ok && (
        <span className="text-xs text-cool-gray">
          Synced {result.courses} courses, {result.assignments} assignments,{" "}
          {result.students} student rows.
        </span>
      )}
      {result && !result.ok && (
        <span className="text-xs text-red-700" title={result.message}>
          Sync failed: {result.message}
        </span>
      )}
    </div>
  );
}
