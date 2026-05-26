import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { getServerDbClient } from "@/lib/supabase/server";
import { bulkSuperGraderScope } from "@/lib/super-grader/scope";
import { CanvasSyncButton } from "./CanvasSyncButton";
import { DiscussionList, type DiscussionListRow } from "./DiscussionList";
import { RecordingFlow } from "./RecordingFlow";
import { TeacherGuide } from "./TeacherGuide";
import type {
  AssignmentOption,
  CourseOption,
  CourseRoster,
  CourseSection,
  RosterStudent,
} from "./TargetPicker";

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

function formatSyncedAt(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// EHS academic year starts in August. If today is August or later, the year
// began Aug 1 of this calendar year; otherwise the previous calendar year.
function academicYearStart(now: Date = new Date()): string {
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-08-01`;
}

export default async function DashboardPage() {
  const teacher = await getCurrentTeacher();
  const supabase = await getServerDbClient();
  const admin = createAdminDbClient();

  const [coursesRes, assignmentsRes, rostersRes, discussionsRes] =
    await Promise.all([
      supabase
        .from("canvas_course_cache")
        .select("canvas_course_id,name,course_code,short_name")
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
      supabase
        .from("discussions")
        .select(
          "id,recorded_at,state,error_message,canvas_course_id,canvas_assignment_id,canvas_section_id,audio_url,transcript,summary,drive_doc_url,canvas_comment_post_status",
        )
        .eq("teacher_id", teacher.id)
        .gte("recorded_at", academicYearStart())
        .order("recorded_at", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);

  const courses: CourseOption[] = (coursesRes.data ?? []).map((c) => ({
    canvas_course_id: c.canvas_course_id,
    name: c.name,
    course_code: c.course_code,
    short_name: c.short_name,
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

  const courseLabelById: Record<string, string> = {};
  for (const c of courses) {
    courseLabelById[c.canvas_course_id] = c.short_name ?? c.course_code ?? c.name;
  }
  const assignmentLabelById: Record<string, string> = {};
  for (const a of assignments) {
    assignmentLabelById[a.canvas_assignment_id] = a.name;
  }
  const sectionLabelById: Record<string, string> = {};
  for (const r of Object.values(rostersByCourseId)) {
    for (const s of r.sections) {
      sectionLabelById[s.id] = s.name;
    }
  }

  // Generate signed URLs for recent discussions' audio (private bucket).
  const rawDiscussions = discussionsRes.data ?? [];
  const signedUrls = await Promise.all(
    rawDiscussions.map(async (d) => {
      const { data } = await admin.storage
        .from("discussion-audio")
        .createSignedUrl(d.audio_url, SIGNED_URL_TTL_SECONDS);
      return data?.signedUrl ?? null;
    }),
  );
  const discussions: DiscussionListRow[] = rawDiscussions.map((d, i) => ({
    id: d.id,
    recorded_at: d.recorded_at,
    state: d.state,
    error_message: d.error_message,
    canvas_course_id: d.canvas_course_id,
    canvas_assignment_id: d.canvas_assignment_id,
    canvas_section_id: d.canvas_section_id,
    audio_signed_url: signedUrls[i] ?? null,
    has_transcript: !!d.transcript && d.transcript.length > 0,
    has_summary: !!d.summary && d.summary.length > 0,
    drive_doc_url: d.drive_doc_url,
    canvas_comment_post_status: d.canvas_comment_post_status,
  }));

  // Ask super-grader which assignments it's tracking — for the indicator
  // badge on each discussion row. HH doesn't post to Canvas, so this is
  // informational only: the badge tells the teacher SG will collect this
  // discussion's transcript + summary alongside the essay grading flow.
  const sgScopeMap = await bulkSuperGraderScope(
    discussions.map((d) => d.canvas_assignment_id),
  );
  const superGraderScopeByAssignmentId: Record<string, boolean> = {};
  for (const [id, scope] of sgScopeMap.entries()) {
    superGraderScopeByAssignmentId[id] = scope.in_scope;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-medium text-ink">Your discussions</h1>
        <TeacherGuide />
      </header>

      <RecordingFlow
        courses={courses}
        assignments={assignments}
        rostersByCourseId={rostersByCourseId}
      />

      <section className="rounded-md border border-stone-200 bg-white p-5">
        <h2 className="ehs-eyebrow mb-3 text-cool-gray">Discussions this year</h2>
        <DiscussionList
          discussions={discussions}
          courseLabelById={courseLabelById}
          assignmentLabelById={assignmentLabelById}
          sectionLabelById={sectionLabelById}
          superGraderScopeByAssignmentId={superGraderScopeByAssignmentId}
        />
      </section>

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
