import { getCurrentTeacher } from "@/lib/auth/teacher";
import { getServerDbClient } from "@/lib/supabase/server";
import { CanvasSyncButton } from "./CanvasSyncButton";
import { RecordingFlow } from "./RecordingFlow";
import type {
  AssignmentOption,
  CourseOption,
  CourseRoster,
  CourseSection,
  RosterStudent,
} from "./TargetPicker";

function formatSyncedAt(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function DashboardPage() {
  const teacher = await getCurrentTeacher();
  const supabase = await getServerDbClient();

  const [coursesRes, assignmentsRes, rostersRes] = await Promise.all([
    supabase
      .from("canvas_course_cache")
      .select("canvas_course_id,name,course_code")
      .eq("teacher_id", teacher.id)
      .order("name"),
    supabase
      .from("canvas_assignment_cache")
      .select("canvas_course_id,canvas_assignment_id,name,due_at")
      .eq("teacher_id", teacher.id)
      .eq("workflow_state", "published"),
    supabase
      .from("course_rosters")
      .select("canvas_course_id,students,sections")
      .eq("teacher_id", teacher.id),
  ]);

  const courses: CourseOption[] = (coursesRes.data ?? []).map((c) => ({
    canvas_course_id: c.canvas_course_id,
    name: c.name,
    course_code: c.course_code,
  }));
  const assignments: AssignmentOption[] = (assignmentsRes.data ?? []).map((a) => ({
    canvas_course_id: a.canvas_course_id,
    canvas_assignment_id: a.canvas_assignment_id,
    name: a.name,
    due_at: a.due_at,
  }));
  const rostersByCourseId: Record<string, CourseRoster> = {};
  for (const row of rostersRes.data ?? []) {
    const students = Array.isArray(row.students)
      ? (row.students as RosterStudent[])
      : [];
    const sections = Array.isArray(row.sections)
      ? (row.sections as CourseSection[])
      : [];
    rostersByCourseId[row.canvas_course_id] = {
      students: students.sort((a, b) => a.name.localeCompare(b.name)),
      sections: sections.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">
          Welcome, {teacher.display_name}
        </h1>
      </header>

      <RecordingFlow
        courses={courses}
        assignments={assignments}
        rostersByCourseId={rostersByCourseId}
      />

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-4 text-xs text-cool-gray">
        <span>
          Canvas cache: {courses.length} courses · {assignments.length}{" "}
          assignments · last synced {formatSyncedAt(teacher.last_canvas_sync_at)}
        </span>
        <CanvasSyncButton />
      </footer>
    </div>
  );
}
