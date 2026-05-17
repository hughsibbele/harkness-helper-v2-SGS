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
        aria-label="Delete discussion"
        className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-medium text-cool-gray hover:border-red-300 hover:bg-red-50 hover:text-red-700"
      >
        <TrashIcon />
        Delete
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="rounded-md bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Confirm delete"}
      </button>
      <button
        type="button"
        onClick={() => setConfirm(false)}
        disabled={pending}
        className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-cool-gray hover:bg-stone-100 disabled:opacity-50"
      >
        Cancel
      </button>
    </span>
  );
}

function TrashIcon() {
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
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="M3.5 4l.5 9a1 1 0 001 1h6a1 1 0 001-1l.5-9" />
      <path d="M6.5 7v4" />
      <path d="M9.5 7v4" />
    </svg>
  );
}
