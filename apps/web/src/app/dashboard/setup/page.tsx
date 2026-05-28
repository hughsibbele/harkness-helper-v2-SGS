import { getCurrentTeacher } from "@/lib/auth/teacher";
import { disconnectCanvas } from "@/lib/actions/canvas-token";
import { getServerDbClient } from "@/lib/supabase/server";
import { ConnectForm } from "./ConnectForm";
import { TestCanvasButton } from "./TestCanvasButton";
import { CanvasCommentToggle } from "./CanvasCommentToggle";
import { CourseNicknameEditor } from "./CourseNicknameEditor";

export default async function SetupPage() {
  const teacher = await getCurrentTeacher();

  const canvasConnected = Boolean(
    teacher.canvas_token_encrypted && teacher.canvas_host,
  );

  const supabase = await getServerDbClient();
  const { data: coursesData } = await supabase
    .from("canvas_course_cache")
    .select("canvas_course_id,name,course_code,short_name")
    .eq("teacher_id", teacher.id)
    .order("name");

  const driveConnected = Boolean(
    teacher.google_access_token_encrypted &&
      teacher.google_refresh_token_encrypted,
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
      <section className="rounded-md border border-stone-200 bg-white p-5 text-sm space-y-4">
        <h2 className="text-sm font-semibold text-ink">Canvas</h2>

        {canvasConnected ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs">
            <div className="flex items-center gap-2 font-medium text-emerald-900">
              <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              Connected
            </div>
            <div className="mt-1 text-emerald-800">
              Authenticated on{" "}
              <code className="rounded bg-white/60 px-1 font-mono">
                {teacher.canvas_host}
              </code>
              . Token is encrypted at rest.
            </div>
            <form action={disconnectCanvas} className="mt-2">
              <button
                type="submit"
                className="text-xs font-medium text-emerald-900 underline underline-offset-2 hover:text-emerald-700"
              >
                Disconnect
              </button>
            </form>
          </div>
        ) : (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs">
            <div className="flex items-center gap-2 font-medium text-amber-900">
              <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" />
              Not connected
            </div>
            <div className="mt-1 text-amber-800">
              Generate a Canvas access token and paste it below to enable
              course listings, roster sync, and draft-comment posting.
            </div>
          </div>
        )}

        <div className="rounded-md border border-stone-200 bg-paper p-3 text-xs">
          <p className="mb-2 font-medium text-stone-900">
            {canvasConnected ? "Replace token" : "Connect Canvas"}
          </p>
          <ol className="mb-3 list-decimal space-y-1 pl-5 leading-relaxed text-cool-gray">
            <li>
              Open Canvas → <em>Account</em> → <em>Settings</em>.
            </li>
            <li>
              Scroll to <em>Approved Integrations</em> and click{" "}
              <em>+ New Access Token</em>.
            </li>
            <li>
              Give it a name like &ldquo;Harkness Helper&rdquo;, leave the
              expiration blank, click <em>Generate Token</em>, and copy the
              value (Canvas only shows it once).
            </li>
          </ol>
          <ConnectForm />
        </div>

        {canvasConnected && <TestCanvasButton />}
      </section>

      {/* Course nicknames */}
      <section className="rounded-md border border-stone-200 bg-white p-5 space-y-3">
        <h2 className="text-sm font-semibold text-ink">Course short names</h2>
        <p className="text-xs text-cool-gray">
          Short names appear in the course picker and discussion labels.
          Leave blank to use the Canvas course code.
        </p>
        <CourseNicknameEditor courses={coursesData ?? []} />
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
