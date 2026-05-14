import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerDbClient } from "@/lib/supabase/server";
import { BrandHeader } from "@/components/BrandHeader";

const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed:
    "Sign-in is restricted to @episcopalhighschool.org Google accounts.",
  missing_code: "Sign-in didn't complete. Please try again.",
  no_user: "Sign-in didn't complete. Please try again.",
  oauth_init_failed:
    "Couldn't start the Google sign-in. Please try again in a moment.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string; next?: string }>;
}) {
  const supabase = await getServerDbClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  const { auth_error, next } = await searchParams;
  const errorMessage =
    auth_error &&
    (ERROR_MESSAGES[auth_error] ?? `Sign-in failed: ${auth_error}`);

  const loginHref = next
    ? `/auth/login?next=${encodeURIComponent(next)}`
    : "/auth/login";

  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <BrandHeader eyebrow="Harkness Discussions" />

      <main className="flex-1 px-6 py-16">
        <article className="mx-auto w-full max-w-2xl space-y-10">
          <header className="space-y-4">
            <div className="ehs-eyebrow text-maroon">For teachers</div>
            <h1 className="text-4xl leading-[1.15] text-ink">
              Capture, transcribe, and grade Harkness discussions.
            </h1>
            <p className="text-base leading-relaxed text-cool-gray">
              Record a classroom discussion, upload the audio, and pick the
              Canvas assignment it&rsquo;s tied to. We&rsquo;ll transcribe it
              with Gemini and hand the transcript to super-grader for editing,
              grading, and Canvas posting.
            </p>
          </header>

          <hr className="ehs-rule" />

          {errorMessage && (
            <div
              role="alert"
              className="rounded-sm border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
            >
              {errorMessage}
            </div>
          )}

          <div className="space-y-2 pt-2">
            <Link
              href={loginHref}
              className="inline-flex w-full items-center justify-center gap-2.5 rounded-sm bg-maroon px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-maroon-dark"
            >
              Sign in with EHS Google
            </Link>
            <p className="text-center text-xs italic text-cool-gray">
              EHS Workspace accounts only.
            </p>
          </div>
        </article>
      </main>

      <footer className="px-6 py-6 text-center text-xs italic text-cool-gray">
        Harkness Helper v2 &middot; Episcopal High School
      </footer>
    </div>
  );
}
