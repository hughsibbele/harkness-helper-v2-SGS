"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// M6.22 Phase 3a — sessionStorage key for picker participant selection.
// Keyed by (canvas_course_id, canvas_section_id) so a teacher can switch
// between sections without losing their de-selections in either.
const PARTICIPANT_STORAGE_PREFIX = "hh.picker.participants:";

function storageKey(courseId: string, sectionId: string | null): string {
  return `${PARTICIPANT_STORAGE_PREFIX}${courseId}:${sectionId ?? "all"}`;
}

function loadPersistedParticipants(
  courseId: string,
  sectionId: string | null,
): Set<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(courseId, sectionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return null;
  }
}

function persistParticipants(
  courseId: string,
  sectionId: string | null,
  ids: Set<string>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      storageKey(courseId, sectionId),
      JSON.stringify([...ids]),
    );
  } catch {
    // sessionStorage is best-effort — quota/Safari-private-mode failures
    // just mean the picker won't survive a polling refresh, which is
    // exactly the prior behavior.
  }
}

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
  section_ids: string[];
};

export type CourseSection = {
  id: string;
  name: string;
};

export type CourseRoster = {
  students: RosterStudent[];
  sections: CourseSection[];
};

export type TargetSelection = {
  course: CourseOption | null;
  assignment: AssignmentOption | null;
  section: CourseSection | null;
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
  rostersByCourseId: Record<string, CourseRoster>;
  onChange?: (selection: TargetSelection) => void;
}) {
  const [courseId, setCourseId] = useState<string | null>(null);
  const [assignmentId, setAssignmentId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [participantIds, setParticipantIds] = useState<Set<string>>(new Set());

  const selectedCourse =
    courses.find((c) => c.canvas_course_id === courseId) ?? null;
  const selectedAssignment =
    assignments.find((a) => a.canvas_assignment_id === assignmentId) ?? null;
  const courseRoster = courseId
    ? (rostersByCourseId[courseId] ?? { students: [], sections: [] })
    : { students: [], sections: [] };
  const visibleStudents = sectionId
    ? courseRoster.students.filter((s) => s.section_ids.includes(sectionId))
    : courseRoster.students;

  // M6.22 Phase 3a — track which (courseId, sectionId) binding we've
  // already initialized participants for. Without this, the participants
  // effect fires every time `rostersByCourseId` changes identity — which
  // happens every 5s during dashboard polling (the page re-renders on
  // router.refresh()) — silently clobbering manual de-selections back to
  // "all in section." Closes audit-canvas.md C1.
  const initializedBindingRef = useRef<string | null>(null);

  // Reset section when course changes. If there's exactly one section, snap to it.
  // Depend only on the stable parent prop + courseId — courseRoster is
  // re-derived per render so its array refs change every render and would
  // cause an infinite loop here.
  /* eslint-disable react-hooks/set-state-in-effect -- derived selection reset on external prop change */
  useEffect(() => {
    const sections = courseId
      ? (rostersByCourseId[courseId]?.sections ?? [])
      : [];
    if (sections.length === 1) {
      setSectionId(sections[0]?.id ?? null);
    } else {
      setSectionId(null);
    }
  }, [courseId, rostersByCourseId]);

  // Default participants to "all currently visible" — but ONLY ONCE per
  // (courseId, sectionId) binding. Subsequent re-renders (server polling
  // refreshes giving us a fresh `rostersByCourseId` object reference)
  // must NOT re-clobber the teacher's manual de-selections.
  //
  // On binding change, restore the sessionStorage-persisted set if one
  // exists for the new binding; otherwise default to all visible.
  useEffect(() => {
    if (!courseId) {
      initializedBindingRef.current = null;
      setParticipantIds(new Set());
      return;
    }
    const binding = `${courseId}:${sectionId ?? "all"}`;
    if (initializedBindingRef.current === binding) return;
    initializedBindingRef.current = binding;

    const persisted = loadPersistedParticipants(courseId, sectionId);
    if (persisted) {
      setParticipantIds(persisted);
      return;
    }

    const students = rostersByCourseId[courseId]?.students ?? [];
    const pool = sectionId
      ? students.filter((s) => s.section_ids.includes(sectionId))
      : students;
    setParticipantIds(new Set(pool.map((s) => s.canvas_user_id)));
  }, [courseId, sectionId, rostersByCourseId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectedSection =
    courseRoster.sections.find((s) => s.id === sectionId) ?? null;

  // Notify parent on any change. The effect makes this a single source of truth.
  useEffect(() => {
    onChange?.({
      course: selectedCourse,
      assignment: selectedAssignment,
      section: selectedSection,
      participantIds: Array.from(participantIds),
    });
  }, [selectedCourse, selectedAssignment, selectedSection, participantIds, onChange]);

  // M6.22 Phase 3a — mirror the live participantIds set into
  // sessionStorage so a polling refresh can rehydrate it instead of
  // re-defaulting to "all in section." Guarded by initializedBindingRef
  // so we don't write before the initialization effect has run.
  useEffect(() => {
    if (!courseId) return;
    if (initializedBindingRef.current !== `${courseId}:${sectionId ?? "all"}`) {
      return;
    }
    persistParticipants(courseId, sectionId, participantIds);
  }, [courseId, sectionId, participantIds]);

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
    setParticipantIds(new Set(visibleStudents.map((s) => s.canvas_user_id)));
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

      {courseId && courseRoster.sections.length > 1 && (
        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-cool-gray">
            Section
          </div>
          <div className="flex flex-wrap gap-2">
            <Chip selected={sectionId === null} onClick={() => setSectionId(null)}>
              All sections
            </Chip>
            {courseRoster.sections.map((s) => (
              <Chip
                key={s.id}
                selected={s.id === sectionId}
                onClick={() => setSectionId(s.id)}
              >
                {s.name}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {courseId && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wide text-cool-gray">
              Participants ({participantIds.size}/{visibleStudents.length})
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
            {visibleStudents.length === 0 && (
              <li className="px-3 py-2 text-sm text-cool-gray">
                {courseRoster.students.length === 0
                  ? "No roster cached for this course. Refresh Canvas if you just added students."
                  : "No students in this section."}
              </li>
            )}
            {visibleStudents.map((s) => {
              const checked = participantIds.has(s.canvas_user_id);
              return (
                <li key={s.canvas_user_id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm hover:bg-stone-100">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleParticipant(s.canvas_user_id)}
                      className="h-4 w-4 rounded border-stone-300 accent-maroon focus:ring-maroon/40"
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
        // M6.18d: confirmation summary echoes the bar-pattern's
        // describeDestination() hint line shape — plain-English summary of
        // what's about to happen, rendered in italic muted text.
        <div className="rounded-md border border-maroon/20 bg-maroon/5 px-3 py-2 text-xs italic text-cool-gray">
          Recording will be linked to{" "}
          <span className="font-medium not-italic text-ink">
            {selectedAssignment.name}
          </span>{" "}
          in{" "}
          <span className="font-medium not-italic text-ink">
            {selectedCourse.course_code ?? selectedCourse.name}
          </span>
          {participantIds.size > 0 && (
            <>
              {" "}with{" "}
              <span className="font-medium not-italic text-ink">
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
  // M6.18d: chip selected state uses maroon to match the bar-pattern's
  // accent across AID / HAH / OE. Unselected stays neutral so the focus
  // weight in the picker is on the active choice.
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full border px-3 py-1 text-xs font-medium transition" +
        (selected
          ? " border-maroon bg-maroon text-white"
          : " border-stone-300 bg-white text-cool-gray hover:border-maroon/40 hover:bg-stone-100")
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
