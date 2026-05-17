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
  audio_signed_url: string | null;
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
}: {
  discussions: DiscussionListRow[];
  courseLabelById: Record<string, string>;
  assignmentLabelById: Record<string, string>;
}) {
  if (discussions.length === 0) {
    return (
      <p className="text-sm text-cool-gray">
        No discussions yet. Record one above to get started.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-stone-200">
      {discussions.map((d) => {
        const style = STATE_STYLES[d.state];
        const courseLabel =
          courseLabelById[d.canvas_course_id] ?? d.canvas_course_id;
        const assignmentLabel =
          assignmentLabelById[d.canvas_assignment_id] ?? d.canvas_assignment_id;
        return (
          <li key={d.id} className="py-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="font-medium text-ink">{assignmentLabel}</span>
              <span className="text-xs text-cool-gray">{courseLabel}</span>
              <span className="text-xs text-cool-gray">·</span>
              <span className="text-xs text-cool-gray">
                {formatDate(d.recorded_at)}
              </span>
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
