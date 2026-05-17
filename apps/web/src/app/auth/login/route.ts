import { NextResponse, type NextRequest } from "next/server";
import { getServerDbClient } from "@/lib/supabase/server";

// Starts the Google OAuth flow via Supabase. The `hd` query param hints at
// the EHS Workspace domain; actual enforcement happens in /auth/callback.
export async function GET(request: NextRequest) {
  const supabase = await getServerDbClient();

  const next = request.nextUrl.searchParams.get("next") ?? "/dashboard";
  const callbackUrl = new URL("/auth/callback", request.nextUrl.origin);
  callbackUrl.searchParams.set("next", next);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackUrl.toString(),
      // drive.file = create + manage files this app creates (not user's
      // existing files); documents = edit any Doc the app has access to.
      // access_type=offline returns a refresh_token (only on first
      // consent per Google's behavior) so server-side calls can outlive
      // the 1-hour access_token.
      scopes:
        "https://www.googleapis.com/auth/drive.file " +
        "https://www.googleapis.com/auth/documents",
      queryParams: {
        hd: "episcopalhighschool.org",
        // `prompt: consent` forces the Google consent screen on every
        // sign-in. Required for a refresh_token to be returned: Google's
        // documented behavior is to issue a refresh_token only on first
        // consent. If the same Google account previously consented to the
        // same scopes via a sibling app on the SAME OAuth client (e.g.
        // HH), the consent step is silently skipped and no refresh_token
        // is returned — which breaks server-side Drive calls after the
        // 1-hour access_token expires. Forcing consent costs one extra
        // click per sign-in; the alternative is a half-working integration.
        prompt: "consent",
        access_type: "offline",
      },
    },
  });

  if (error || !data.url) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.set("auth_error", error?.message ?? "oauth_init_failed");
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(data.url);
}
