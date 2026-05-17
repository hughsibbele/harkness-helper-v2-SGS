"use client";

import { useMemo, useState } from "react";

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

export type TargetSelection = {
  course: CourseOption | null;
  assignment: AssignmentOption | null;
};

export function TargetPicker({
  courses,
  assignments,
  onChange,
}: {
  courses: CourseOption[];
  assignments: AssignmentOption[];
  onChange?: (selection: TargetSelection) => void;
}) {
  const [courseId, setCourseId] = useState<string | null>(null);
  const [assignmentId, setAssignmentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const selectedCourse = courses.find((c) => c.canvas_course_id === courseId) ?? null;
  const selectedAssignment =
    assignments.find((a) => a.canvas_assignment_id === assignmentId) ?? null;

  const visibleAssignments = useMemo(
    () => sortAndFilterAssignments(assignments, courseId, query),
    [assignments, courseId, query],
  );

  function pickCourse(id: string | null) {
    setCourseId(id);
    // If the currently-selected assignment doesn't belong to this course,
    // drop it. Last pick wins — picking a course wins over a stale assignment.
    if (id && selectedAssignment && selectedAssignment.canvas_course_id !== id) {
      setAssignmentId(null);
      onChange?.({
        course: courses.find((c) => c.canvas_course_id === id) ?? null,
        assignment: null,
      });
      return;
    }
    onChange?.({
      course: courses.find((c) => c.canvas_course_id === id) ?? null,
      assignment: selectedAssignment,
    });
  }

  function pickAssignment(a: AssignmentOption) {
    setAssignmentId(a.canvas_assignment_id);
    // Auto-snap course to the assignment's owner. Last pick wins.
    if (a.canvas_course_id !== courseId) {
      setCourseId(a.canvas_course_id);
    }
    onChange?.({
      course: courses.find((c) => c.canvas_course_id === a.canvas_course_id) ?? null,
      assignment: a,
    });
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

      {selectedCourse && selectedAssignment && (
        <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-cool-gray">
          Recording will be linked to{" "}
          <span className="font-medium text-ink">{selectedAssignment.name}</span>{" "}
          in{" "}
          <span className="font-medium text-ink">
            {selectedCourse.course_code ?? selectedCourse.name}
          </span>
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
