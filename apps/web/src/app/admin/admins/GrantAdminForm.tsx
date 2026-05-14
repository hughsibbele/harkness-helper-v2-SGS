"use client";

import { useState, useTransition } from "react";
import { grantAdmin } from "@/lib/actions/admins";

export function GrantAdminForm({
  requiredDomain,
}: {
  requiredDomain: string | null;
}) {
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<
    | null
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
  >(null);

  function onGrant() {
    setFeedback(null);
    startTransition(async () => {
      const r = await grantAdmin(email);
      if (r.ok) {
        setFeedback({
          kind: "ok",
          message: `${email} can now sign in to /admin.`,
        });
        setEmail("");
      } else {
        setFeedback({ kind: "error", message: r.message });
      }
    });
  }

  return (
    <section className="rounded-md border border-stone-200 bg-white p-4">
      <h2 className="mb-1 text-sm font-semibold text-ink">
        Grant admin access
      </h2>
      <p className="mb-3 text-xs text-cool-gray">
        Email must match the user&rsquo;s EHS Google account exactly
        {requiredDomain && (
          <>
            {" "}
            (must be on{" "}
            <span className="font-mono text-ink">@{requiredDomain}</span>)
          </>
        )}
        .
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teacher@episcopalhighschool.org"
          spellCheck={false}
          className="min-w-[260px] flex-1 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-dark-blue focus:outline-none focus:ring-1 focus:ring-dark-blue"
        />
        <button
          type="button"
          onClick={onGrant}
          disabled={pending || !email.trim()}
          className="rounded-md bg-dark-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-dark-blue-dark disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
        >
          {pending ? "Granting…" : "Grant"}
        </button>
      </div>
      {feedback && (
        <div
          className={`mt-2 text-xs ${
            feedback.kind === "ok" ? "text-emerald-700" : "text-red-700"
          }`}
        >
          {feedback.message}
        </div>
      )}
    </section>
  );
}
