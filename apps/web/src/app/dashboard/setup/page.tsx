import { getCurrentTeacher } from "@/lib/auth/teacher";
import { isAdmin } from "@/lib/auth/admin";
import { TestCanvasButton } from "./TestCanvasButton";

export default async function SetupPage() {
  const teacher = await getCurrentTeacher();
  const admin = await isAdmin();

  const canvasHost = process.env.CANVAS_BASE_URL ?? "(not set)";
  const canvasTokenPresent = Boolean(process.env.CANVAS_API_TOKEN);

  const driveConnected = Boolean(
    teacher.google_access_token && teacher.google_refresh_token,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Canvas &amp; Drive setup
        </h1>
        <p className="mt-1 text-sm text-cool-gray">
          Verify the connections Harkness Helper needs to read your courses
          and save transcripts to Drive.
        </p>
      </div>

      {/* Canvas */}
      <section className="rounded-md border border-stone-200 bg-white p-5 text-sm">
        <h2 className="mb-2 text-sm font-semibold text-ink">Canvas</h2>
        <p className="mb-3 text-xs text-cool-gray">
          HH currently uses a single shared Canvas API token for the whole
          school (single-tenant by design). The token + host live as
          environment variables on Vercel — only an admin can update them.
        </p>

        <dl className="mb-3 grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
          <dt className="text-cool-gray">Host</dt>
          <dd>
            <code className="rounded bg-paper px-1">{canvasHost}</code>
          </dd>
          <dt className="text-cool-gray">Token</dt>
          <dd>
            {canvasTokenPresent ? (
              <span className="text-emerald-800">set</span>
            ) : (
              <span className="text-red-700">missing</span>
            )}
          </dd>
        </dl>

        <TestCanvasButton />

        {admin && (
          <div className="mt-4 rounded border border-dashed border-stone-300 bg-stone-50 p-3 text-xs text-stone-700">
            <p className="mb-1 font-medium text-stone-900">
              Token rotation (admin)
            </p>
            <p className="mb-2 leading-relaxed">
              Update on the HH Vercel project under Settings → Environment
              Variables. After updating, redeploy so the new value reaches
              running serverless functions. Per-teacher Canvas tokens are
              tracked as a future harmonization task.
            </p>
            <a
              href="https://vercel.com/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="text-maroon hover:underline"
            >
              Open Vercel dashboard →
            </a>
          </div>
        )}
      </section>

      {/* Drive */}
      <section className="rounded-md border border-stone-200 bg-white p-5 text-sm">
        <h2 className="mb-2 text-sm font-semibold text-ink">Google Drive</h2>
        <p className="mb-3 text-xs text-cool-gray">
          Per-teacher OAuth. Drive scopes are requested when you sign in
          with Google. Used by the &ldquo;Save to Drive&rdquo; menu on each
          discussion row.
        </p>

        <dl className="mb-3 grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
          <dt className="text-cool-gray">Status</dt>
          <dd>
            {driveConnected ? (
              <span className="text-emerald-800">
                ✓ Connected for {teacher.display_name}
              </span>
            ) : (
              <span className="text-amber-700">
                Not connected — sign out and back in with Google to grant
                Drive scopes.
              </span>
            )}
          </dd>
          {driveConnected && teacher.google_token_expires_at && (
            <>
              <dt className="text-cool-gray">Access token expires</dt>
              <dd className="text-stone-700">
                {new Date(teacher.google_token_expires_at).toLocaleString()}{" "}
                <span className="text-cool-gray">
                  (auto-refreshed when within 5 min of expiry)
                </span>
              </dd>
            </>
          )}
        </dl>

        {!driveConnected && (
          <form action="/auth/logout" method="post">
            <button
              type="submit"
              className="rounded border border-maroon px-3 py-1.5 text-xs font-medium text-maroon transition-colors hover:bg-maroon hover:text-white"
            >
              Sign out to reconnect
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
