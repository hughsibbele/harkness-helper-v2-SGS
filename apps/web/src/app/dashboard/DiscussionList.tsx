"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DeleteDiscussionButton } from "./DeleteDiscussionButton";
import { SaveToDriveMenu } from "./SaveToDriveMenu";

const POLL_INTERVAL_MS = 5000;

export type DiscussionState =
  | "uploaded"
  | "transcribing"
  | "transcribed"
  | "posted_to_super_grader"
  | "failed";

export type DiscussionListRow = {
  id: string;
  recorded_at: string;
  state: DiscussionState;
  error_message: string | null;
  canvas_course_id: string;
  canvas_assignment_id: string;
  canvas_section_id: string | null;
  audio_signed_url: string | null;
  has_transcript: boolean;
};

const STATE_STYLES: Record<DiscussionState, { dot: string; label: string }> = {
  uploaded: { dot: "bg-amber-500", label: "Awaiting transcription" },
  transcribing: { dot: "bg-blue-500 animate-pulse", label: "Transcribing" },
  transcribed: { dot: "bg-emerald-600", label: "Transcribed" },
  posted_to_super_grader: {
    dot: "bg-violet-600",
    label: "Posted to super-grader",
  },
  failed: { dot: "bg-red-600", label: "Failed" },
};

export function DiscussionList({
  discussions,
  courseLabelById,
  assignmentLabelById,
  sectionLabelById,
}: {
  discussions: DiscussionListRow[];
  courseLabelById: Record<string, string>;
  assignmentLabelById: Record<string, string>;
  sectionLabelById: Record<string, string>;
}) {
  const router = useRouter();
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Auto-refresh whenever any discussion is in a non-terminal state. Stops
  // as soon as everything is transcribed/posted/failed (terminal). Uses
  // router.refresh() so the server re-runs page data fetches in place
  // without a hard reload (preserves filter/search state and scroll).
  const hasPending = useMemo(
    () =>
      discussions.some(
        (d) => d.state === "uploaded" || d.state === "transcribing",
      ),
    [discussions],
  );
  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasPending, router]);

  // Distinct courses among this year's discussions, ordered by label.
  const courseChips = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of discussions) {
      if (seen.has(d.canvas_course_id)) continue;
      seen.set(
        d.canvas_course_id,
        courseLabelById[d.canvas_course_id] ?? d.canvas_course_id,
      );
    }
    return Array.from(seen.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [discussions, courseLabelById]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return discussions.filter((d) => {
      if (courseFilter && d.canvas_course_id !== courseFilter) return false;
      if (!q) return true;
      const assignmentLabel = (
        assignmentLabelById[d.canvas_assignment_id] ?? ""
      ).toLowerCase();
      return assignmentLabel.includes(q);
    });
  }, [discussions, courseFilter, query, assignmentLabelById]);

  if (discussions.length === 0) {
    return (
      <p className="text-sm text-cool-gray">
        No discussions yet this academic year. Record one above to get started.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          selected={courseFilter === null}
          onClick={() => setCourseFilter(null)}
        >
          All
        </Chip>
        {courseChips.map((c) => (
          <Chip
            key={c.id}
            selected={c.id === courseFilter}
            onClick={() => setCourseFilter(c.id)}
          >
            {c.label}
          </Chip>
        ))}
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by assignment name…"
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink focus:border-stone-500 focus:outline-none"
      />

      <div className="text-xs text-cool-gray">
        Showing {filtered.length} of {discussions.length} this academic year
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-cool-gray">
          No discussions match your filters.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200">
          {filtered.map((d) => {
            const style = STATE_STYLES[d.state];
            const courseLabel =
              courseLabelById[d.canvas_course_id] ?? d.canvas_course_id;
            const assignmentLabel =
              assignmentLabelById[d.canvas_assignment_id] ??
              d.canvas_assignment_id;
            const sectionLabel = d.canvas_section_id
              ? (sectionLabelById[d.canvas_section_id] ?? null)
              : null;
            return (
              <li key={d.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-medium text-ink">{assignmentLabel}</span>
                    <span className="text-xs text-cool-gray">{courseLabel}</span>
                    {sectionLabel && (
                      <>
                        <span className="text-xs text-cool-gray">·</span>
                        <span className="text-xs text-cool-gray">
                          {sectionLabel}
                        </span>
                      </>
                    )}
                    <span className="text-xs text-cool-gray">·</span>
                    <span className="text-xs text-cool-gray">
                      {formatDate(d.recorded_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <SaveToDriveMenu
                      discussionId={d.id}
                      hasAudio={d.audio_signed_url !== null}
                      hasTranscript={d.has_transcript}
                    />
                    <DeleteDiscussionButton discussionId={d.id} />
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs">
                  <span
                    aria-hidden="true"
                    className={`inline-block h-2 w-2 rounded-full ${style.dot}`}
                  />
                  <span className="text-cool-gray">{style.label}</span>
                  {d.state === "failed" && d.error_message && (
                    <span className="text-red-700" title={d.error_message}>
                      — {d.error_message}
                    </span>
                  )}
                </div>
                {d.audio_signed_url && (
                  <audio
                    src={d.audio_signed_url}
                    controls
                    preload="none"
                    className="mt-2 w-full"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full border px-3 py-1 text-xs font-medium transition" +
        (selected
          ? " border-ink bg-ink text-white"
          : " border-stone-300 bg-white text-cool-gray hover:bg-stone-100")
      }
    >
      {children}
    </button>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
