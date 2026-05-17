"use client";

import { useState, useTransition } from "react";
import { deleteDiscussion } from "@/lib/actions/delete-discussion";

export function DeleteDiscussionButton({
  discussionId,
}: {
  discussionId: string;
}) {
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    startTransition(async () => {
      const r = await deleteDiscussion(discussionId);
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
        className="text-[11px] text-cool-gray underline-offset-2 hover:text-red-700 hover:underline"
      >
        Delete
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1 text-[11px]">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="rounded-md bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Confirm"}
      </button>
      <button
        type="button"
        onClick={() => setConfirm(false)}
        disabled={pending}
        className="rounded-md px-2 py-0.5 text-cool-gray hover:bg-stone-100 disabled:opacity-50"
      >
        Cancel
      </button>
    </span>
  );
}
