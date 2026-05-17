"use client";

import { useEffect, useMemo, useState } from "react";

export type CourseOption = {
  canvas_course_id: string;
  name: string;
  course_code: string | null;
};

export type AssignmentOption = {
  canvas_course_id: string;
  canvas_assignment_id: string;
  name: string;
  due_at: string | null;
};

export type RosterStudent = {
  canvas_user_id: string;
  name: string;
  email: string | null;
};

export type TargetSelection = {
  course: CourseOption | null;
  assignment: AssignmentOption | null;
  participantIds: string[];
};

export function TargetPicker({
  courses,
  assignments,
  rostersByCourseId,
  onChange,
}: {
  courses: CourseOption[];
  assignments: AssignmentOption[];
  rostersByCourseId: Record<string, RosterStudent[]>;
  onChange?: (selection: TargetSelection) => void;
}) {
  const [courseId, setCourseId] = useState<string | null>(null);
  const [assignmentId, setAssignmentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [participantIds, setParticipantIds] = useState<Set<string>>(new Set());

  const selectedCourse =
    courses.find((c) => c.canvas_course_id === courseId) ?? null;
  const selectedAssignment =
    assignments.find((a) => a.canvas_assignment_id === assignmentId) ?? null;
  const roster = courseId ? (rostersByCourseId[courseId] ?? []) : [];

  // Default participants to "all in this course" whenever the course changes.
  useEffect(() => {
    if (courseId) {
      setParticipantIds(
        new Set((rostersByCourseId[courseId] ?? []).map((s) => s.canvas_user_id)),
      );
    } else {
      setParticipantIds(new Set());
    }
  }, [courseId, rostersByCourseId]);

  // Notify parent on any change. The effect makes this a single source of truth.
  useEffect(() => {
    onChange?.({
      course: selectedCourse,
      assignment: selectedAssignment,
      participantIds: Array.from(participantIds),
    });
  }, [selectedCourse, selectedAssignment, participantIds, onChange]);

  const visibleAssignments = useMemo(
    () => sortAndFilterAssignments(assignments, courseId, query),
    [assignments, courseId, query],
  );

  function pickCourse(id: string | null) {
    setCourseId(id);
    if (id && selectedAssignment && selectedAssignment.canvas_course_id !== id) {
      setAssignmentId(null);
    }
  }

  function pickAssignment(a: AssignmentOption) {
    setAssignmentId(a.canvas_assignment_id);
    if (a.canvas_course_id !== courseId) {
      setCourseId(a.canvas_course_id);
    }
  }

  function toggleParticipant(canvasUserId: string) {
    setParticipantIds((prev) => {
      const next = new Set(prev);
      if (next.has(canvasUserId)) {
        next.delete(canvasUserId);
      } else {
        next.add(canvasUserId);
      }
      return next;
    });
  }

  function selectAllParticipants() {
    setParticipantIds(new Set(roster.map((s) => s.canvas_user_id)));
  }

  function deselectAllParticipants() {
    setParticipantIds(new Set());
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-xs uppercase tracking-wide text-cool-gray">
          Course
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip selected={courseId === null} onClick={() => pickCourse(null)}>
            All
          </Chip>
          {courses.map((c) => (
            <Chip
              key={c.canvas_course_id}
              selected={c.canvas_course_id === courseId}
              onClick={() => pickCourse(c.canvas_course_id)}
            >
              {c.course_code ?? c.name}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs uppercase tracking-wide text-cool-gray">
          Assignment
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search assignments…"
          className="w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink focus:border-stone-500 focus:outline-none"
        />
        <ul className="mt-2 max-h-72 overflow-y-auto rounded-md border border-stone-200 bg-white">
          {visibleAssignments.length === 0 && (
            <li className="px-3 py-2 text-sm text-cool-gray">
              {assignments.length === 0
                ? "No cached assignments — sync Canvas first."
                : query
                  ? `No matches for "${query}".`
                  : "No assignments in this course."}
            </li>
          )}
          {visibleAssignments.map((a) => (
            <li key={a.canvas_assignment_id}>
              <button
                type="button"
                onClick={() => pickAssignment(a)}
                className={
                  "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-stone-100" +
                  (a.canvas_assignment_id === assignmentId
                    ? " bg-stone-100 font-semibold text-ink"
                    : " text-ink")
                }
              >
                <span className="truncate">{a.name}</span>
                <span className="shrink-0 text-xs text-cool-gray">
                  {formatDue(a.due_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {courseId && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wide text-cool-gray">
              Participants ({participantIds.size}/{roster.length})
            </span>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={selectAllParticipants}
                className="text-cool-gray underline-offset-2 hover:text-ink hover:underline"
              >
                Select all
              </button>
              <span className="text-stone-300">·</span>
              <button
                type="button"
                onClick={deselectAllParticipants}
                className="text-cool-gray underline-offset-2 hover:text-ink hover:underline"
              >
                Deselect all
              </button>
            </div>
          </div>
          <ul className="max-h-56 overflow-y-auto rounded-md border border-stone-200 bg-white">
            {roster.length === 0 && (
              <li className="px-3 py-2 text-sm text-cool-gray">
                No roster cached for this course. Refresh Canvas if you just
                added students.
              </li>
            )}
            {roster.map((s) => {
              const checked = participantIds.has(s.canvas_user_id);
              return (
                <li key={s.canvas_user_id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm hover:bg-stone-100">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleParticipant(s.canvas_user_id)}
                      className="h-4 w-4 rounded border-stone-300 text-ink focus:ring-stone-500"
                    />
                    <span className="truncate text-ink">{s.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {selectedCourse && selectedAssignment && (
        <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-cool-gray">
          Recording will be linked to{" "}
          <span className="font-medium text-ink">{selectedAssignment.name}</span>{" "}
          in{" "}
          <span className="font-medium text-ink">
            {selectedCourse.course_code ?? selectedCourse.name}
          </span>
          {participantIds.size > 0 && (
            <>
              {" "}with{" "}
              <span className="font-medium text-ink">
                {participantIds.size} participant
                {participantIds.size === 1 ? "" : "s"}
              </span>
            </>
          )}
          .
        </div>
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

function sortAndFilterAssignments(
  assignments: AssignmentOption[],
  courseId: string | null,
  query: string,
): AssignmentOption[] {
  const q = query.trim().toLowerCase();
  const now = Date.now();

  const filtered = assignments.filter((a) => {
    if (courseId && a.canvas_course_id !== courseId) return false;
    if (q && !a.name.toLowerCase().includes(q)) return false;
    return true;
  });

  return filtered.sort((a, b) => {
    const aHk = a.name.toLowerCase().includes("harkness") ? 0 : 1;
    const bHk = b.name.toLowerCase().includes("harkness") ? 0 : 1;
    if (aHk !== bHk) return aHk - bHk;

    const aDist = a.due_at ? Math.abs(new Date(a.due_at).getTime() - now) : Infinity;
    const bDist = b.due_at ? Math.abs(new Date(b.due_at).getTime() - now) : Infinity;
    if (aDist !== bDist) return aDist - bDist;

    return a.name.localeCompare(b.name);
  });
}

function formatDue(due_at: string | null): string {
  if (!due_at) return "—";
  const d = new Date(due_at);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
