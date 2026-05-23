"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type SweepResultOk = {
  ok: true;
  archived: number;
  deleted: number;
  storage_objects_deleted: number;
};
type SweepResultErr = { ok: false; error: string };
type SweepResult = SweepResultOk | SweepResultErr;

export function SweepNowButton() {
  const [confirm, setConfirm] = useState("");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<SweepResult | null>(null);
  const router = useRouter();

  const ready = confirm.trim() === "SWEEP";

  function onClick() {
    if (!ready || isPending) return;
    startTransition(async () => {
      const res = await fetch("/api/admin/retention/sweep", {
        method: "POST",
      });
      const body = (await res
        .json()
        .catch(() => ({}))) as Partial<SweepResultOk> & Partial<SweepResultErr>;
      if (!res.ok || !body.ok) {
        setResult({
          ok: false,
          error: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setResult(body as SweepResultOk);
      setConfirm("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="text-stone-700">
          Type <code className="rounded bg-stone-100 px-1 font-mono">SWEEP</code>{" "}
          to enable the button:
        </span>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 block w-40 rounded-md border border-stone-300 px-2 py-1 text-sm font-mono"
          disabled={isPending}
        />
      </label>
      <button
        type="button"
        onClick={onClick}
        disabled={!ready || isPending}
        className="rounded-md bg-dark-blue px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-dark-blue/90 disabled:cursor-not-allowed disabled:bg-stone-300"
      >
        {isPending ? "Running…" : "Run sweep now"}
      </button>
      {result ? (
        result.ok ? (
          <p className="text-sm text-green-700">
            Archived {result.archived}, hard-deleted {result.deleted}, storage
            objects removed {result.storage_objects_deleted}.
          </p>
        ) : (
          <p className="text-sm text-maroon">Error: {result.error}</p>
        )
      ) : null}
    </div>
  );
}
