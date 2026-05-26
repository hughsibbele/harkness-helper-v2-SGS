import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getServerDbClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await getServerDbClient();
  const cookieStore = await cookies();
  const hasRefreshToken = cookieStore.get("_grt")?.value === "1";

  const next = request.nextUrl.searchParams.get("next") ?? "/dashboard";
  const callbackUrl = new URL("/auth/callback", request.nextUrl.origin);
  callbackUrl.searchParams.set("next", next);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackUrl.toString(),
      scopes:
        "https://www.googleapis.com/auth/drive.file " +
        "https://www.googleapis.com/auth/documents",
      queryParams: {
        hd: "episcopalhighschool.org",
        prompt: hasRefreshToken ? "select_account" : "consent",
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
