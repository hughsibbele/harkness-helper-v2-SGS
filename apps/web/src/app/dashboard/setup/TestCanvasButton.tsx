"use client";

import { useState, useTransition } from "react";
import { testCanvasConnection } from "@/lib/actions/canvas-test";

type Status =
  | { kind: "idle" }
  | { kind: "ok"; userName: string; userId: number; host: string }
  | { kind: "error"; error: string };

export function TestCanvasButton() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function onClick() {
    setStatus({ kind: "idle" });
    startTransition(async () => {
      const r = await testCanvasConnection();
      if (r.ok) {
        setStatus({
          kind: "ok",
          userName: r.userName,
          userId: r.userId,
          host: r.host,
        });
      } else {
        setStatus({ kind: "error", error: r.error });
      }
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded border border-maroon px-3 py-1.5 text-xs font-medium text-maroon transition-colors hover:bg-maroon hover:text-white disabled:opacity-50"
      >
        {pending ? "Testing…" : "Test Canvas connection"}
      </button>
      {status.kind === "ok" && (
        <p className="text-xs text-emerald-800">
          ✓ Connected to{" "}
          <code className="rounded bg-paper px-1">{status.host}</code> as{" "}
          {status.userName} (Canvas id {status.userId}).
        </p>
      )}
      {status.kind === "error" && (
        <p className="text-xs text-red-700">✗ {status.error}</p>
      )}
    </div>
  );
}
