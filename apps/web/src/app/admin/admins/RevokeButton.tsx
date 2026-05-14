"use client";

import { useState, useTransition } from "react";
import { revokeAdmin } from "@/lib/actions/admins";

export function RevokeButton({ email }: { email: string }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    startTransition(async () => {
      const r = await revokeAdmin(email);
      if (!r.ok) {
        setError(r.message);
        setConfirm(false);
      }
    });
  }

  if (error) {
    return (
      <span className="text-[11px] text-red-700" title={error}>
        {error}
      </span>
    );
  }

  if (!confirm) {
    return (
      <button
        type="button"
        onClick={() => setConfirm(true)}
        className="rounded-md border border-stone-300 px-2 py-1 text-[11px] text-cool-gray hover:bg-stone-100"
      >
        Revoke
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1 text-[11px]">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700 disabled:opacity-50"
      >
        {pending ? "Revoking…" : "Confirm"}
      </button>
      <button
        type="button"
        onClick={() => setConfirm(false)}
        disabled={pending}
        className="rounded-md px-2 py-1 text-cool-gray hover:bg-stone-100 disabled:opacity-50"
      >
        Cancel
      </button>
    </span>
  );
}
