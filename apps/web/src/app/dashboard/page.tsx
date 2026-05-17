import { getCurrentTeacher } from "@/lib/auth/teacher";
import { getServerDbClient } from "@/lib/supabase/server";
import { CanvasSyncButton } from "./CanvasSyncButton";

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

  const [{ count: courseCount }, { count: assignmentCount }, rostersRes] =
    await Promise.all([
      supabase
        .from("canvas_course_cache")
        .select("*", { count: "exact", head: true })
        .eq("teacher_id", teacher.id),
      supabase
        .from("canvas_assignment_cache")
        .select("*", { count: "exact", head: true })
        .eq("teacher_id", teacher.id),
      supabase
        .from("course_rosters")
        .select("students")
        .eq("teacher_id", teacher.id),
    ]);

  const studentRows = (rostersRes.data ?? []).reduce<number>((acc, r) => {
    const arr = Array.isArray(r.students) ? r.students : [];
    return acc + arr.length;
  }, 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">
          Welcome, {teacher.display_name}
        </h1>
        <p className="mt-1 text-sm text-cool-gray">
          The recorder + upload form lands here in Phase B. For now, this is
          just a signed-in placeholder so the auth flow is testable.
        </p>
      </header>

      <section className="rounded-md border border-stone-200 bg-white p-5">
        <h2 className="ehs-eyebrow mb-2 text-cool-gray">Canvas cache</h2>
        <p className="mb-3 text-sm text-ink">
          Last synced: {formatSyncedAt(teacher.last_canvas_sync_at)}
        </p>
        <dl className="mb-4 grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-cool-gray">Courses</dt>
            <dd className="text-lg font-semibold text-ink">
              {courseCount ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-cool-gray">Assignments</dt>
            <dd className="text-lg font-semibold text-ink">
              {assignmentCount ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-cool-gray">Student rows</dt>
            <dd className="text-lg font-semibold text-ink">{studentRows}</dd>
          </div>
        </dl>
        <CanvasSyncButton />
      </section>

      <section className="rounded-md border border-stone-200 bg-white p-5">
        <h2 className="ehs-eyebrow mb-2 text-cool-gray">Phase A — shipped</h2>
        <ul className="space-y-1.5 text-sm text-ink">
          <li>· Monorepo + Supabase migrations</li>
          <li>· Google SSO with EHS workspace domain gate</li>
          <li>· Admin layer with first-admin bootstrap</li>
          <li>
            · <code>/admin/prompts</code> — edit the transcription prompt
          </li>
        </ul>
      </section>

      <section className="rounded-md border border-stone-200 bg-white p-5">
        <h2 className="ehs-eyebrow mb-2 text-cool-gray">Up next — Phase B</h2>
        <ul className="space-y-1.5 text-sm text-cool-gray">
          <li>· Browser-based audio recorder</li>
          <li>· Upload form with participant picker</li>
        </ul>
      </section>
    </div>
  );
}
