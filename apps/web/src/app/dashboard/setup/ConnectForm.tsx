"use client";

import { useActionState } from "react";
import { connectCanvas } from "@/lib/actions/canvas-token";
import type { ConnectState } from "@/lib/actions/canvas-token.types";

const initialState: ConnectState = { status: "idle" };

export function ConnectForm() {
  const [state, action, pending] = useActionState(connectCanvas, initialState);

  return (
    <form action={action} className="space-y-3">
      <input
        type="password"
        name="token"
        required
        placeholder="Paste your Canvas API token"
        autoComplete="off"
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 font-mono text-xs shadow-sm focus:border-maroon focus:outline-none focus:ring-1 focus:ring-maroon"
      />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center rounded-md bg-maroon px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-maroon-dark disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
      >
        {pending ? "Verifying…" : "Verify and save"}
      </button>

      {state.status === "error" && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900"
        >
          {state.message}
        </div>
      )}
      {state.status === "ok" && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          Connected as <strong>{state.canvasUserName}</strong>. The page will
          refresh momentarily.
        </div>
      )}
    </form>
  );
}
