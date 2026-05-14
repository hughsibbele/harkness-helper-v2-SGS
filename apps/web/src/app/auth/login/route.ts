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
      queryParams: {
        hd: "episcopalhighschool.org",
        prompt: "select_account",
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
