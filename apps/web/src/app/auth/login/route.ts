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
        prompt: "select_account",
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
