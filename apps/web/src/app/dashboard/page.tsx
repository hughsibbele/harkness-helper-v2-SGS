import { getCurrentTeacher } from "@/lib/auth/teacher";

export default async function DashboardPage() {
  const teacher = await getCurrentTeacher();

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
          <li>· Canvas course/assignment/roster cache + sync</li>
          <li>· Upload form with participant picker</li>
        </ul>
      </section>
    </div>
  );
}
