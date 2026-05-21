"use client";

import { useEffect, useState } from "react";

export type AutoSaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; msg: string };

/**
 * Sticky bottom-right pill that surfaces the current auto-save state.
 * Mirrors the OE pattern (oral-examiner-v2-SGS commit cd69dd8); kept
 * per-app today since the suite hasn't consolidated shared UI into a
 * package yet (suite M5).
 */
export function AutoSaveStatusPill({ status }: { status: AutoSaveStatus }) {
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [seenKind, setSeenKind] = useState(status.kind);
  if (seenKind !== status.kind) {
    setSeenKind(status.kind);
    if (status.kind === "saved") setLastSavedAt(status.at);
  }

  const [relative, setRelative] = useState("just now");
  useEffect(() => {
    if (lastSavedAt === null) return;
    function tick() {
      const elapsed = Math.floor((Date.now() - lastSavedAt!) / 1000);
      if (elapsed < 5) setRelative("just now");
      else if (elapsed < 60) setRelative(`${elapsed}s ago`);
      else if (elapsed < 3600) setRelative(`${Math.floor(elapsed / 60)}m ago`);
      else setRelative(`${Math.floor(elapsed / 3600)}h ago`);
    }
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [lastSavedAt]);

  if (status.kind === "saving") {
    return (
      <Pill cls="bg-white text-ink border-stone-300">
        <Spinner /> Saving…
      </Pill>
    );
  }
  if (status.kind === "error") {
    return (
      <Pill cls="bg-red-50 text-red-800 border-red-300">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-600" />
        Save failed — {status.msg}
      </Pill>
    );
  }
  if (lastSavedAt === null) return null;
  return (
    <Pill cls="bg-emerald-50 text-emerald-800 border-emerald-300">
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-600" />
      Saved · {relative}
    </Pill>
  );
}

function Pill({
  cls,
  children,
}: {
  cls: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-5 right-5 z-50 border rounded-full px-4 py-2 text-sm font-medium shadow-md flex items-center gap-2.5 ${cls}`}
    >
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3.5 h-3.5 border-2 border-current border-r-transparent rounded-full animate-spin"
      aria-hidden
    />
  );
}
