import { getCurrentTeacher } from "@/lib/auth/teacher";
import { isAdmin } from "@/lib/auth/admin";
import { TestCanvasButton } from "./TestCanvasButton";
import { CanvasCommentToggle } from "./CanvasCommentToggle";

export default async function SetupPage() {
  const teacher = await getCurrentTeacher();
  const admin = await isAdmin();

  const canvasHost = process.env.CANVAS_BASE_URL ?? "(not set)";
  const canvasTokenPresent = Boolean(process.env.CANVAS_API_TOKEN);

  // M7.2 — Drive-connected check post-M6.22 Phase 0b: tokens land in
  // *_encrypted columns; the plaintext columns are nulled. Read both
  // shapes so legacy + post-encryption teachers both show as connected.
  const driveConnected = Boolean(
    (teacher.google_access_token_encrypted ?? teacher.google_access_token) &&
      (teacher.google_refresh_token_encrypted ?? teacher.google_refresh_token),
  );
  const driveFolderUrl = teacher.drive_folder_id
    ? `https://drive.google.com/drive/folders/${teacher.drive_folder_id}`
    : null;

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
          with Google. Each transcribed discussion auto-creates a Google
          Doc + audio file in a per-teacher{" "}
          <strong>Harkness Helper</strong> folder; the manual &ldquo;Save
          to Drive&rdquo; menu on each row is still available.
        </p>
        <p className="mb-3 text-xs text-cool-gray">
          <strong>Want everything in a shared folder?</strong> Drag the{" "}
          <strong>Harkness Helper</strong> folder anywhere in your Drive
          — into a shared course folder, into a subfolder, or rename it.
          Future discussion docs will keep landing in the same folder;
          the link stays valid. If you trash it, a fresh one is
          auto-created in your Drive root on the next transcription (and
          you can move that one too).
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
          {driveConnected && (
            <>
              <dt className="text-cool-gray">App folder</dt>
              <dd>
                {driveFolderUrl ? (
                  <a
                    href={driveFolderUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-dark-blue hover:underline"
                  >
                    Open &ldquo;Harkness Helper&rdquo; in Drive ↗
                  </a>
                ) : (
                  <span className="italic text-cool-gray">
                    Auto-created on your first transcribed discussion.
                  </span>
                )}
              </dd>
              {teacher.google_token_expires_at && (
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

      {/* Canvas posting */}
      <section className="rounded-md border border-stone-200 bg-white p-5 text-sm">
        <h2 className="mb-2 text-sm font-semibold text-ink">
          Canvas posting
        </h2>
        <p className="mb-3 text-xs text-cool-gray">
          When a discussion finishes transcribing, Harkness Helper can
          optionally post a draft comment to each participant&rsquo;s
          Canvas submission carrying the Drive doc link. Drafts are only
          visible to you in SpeedGrader until you publish them.
        </p>
        <CanvasCommentToggle
          initialEnabled={teacher.canvas_comment_enabled}
        />
      </section>
    </div>
  );
}
