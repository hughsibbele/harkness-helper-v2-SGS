import { NextResponse, type NextRequest } from "next/server";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getServerDbClient } from "@/lib/supabase/server";

const ALLOWED_DOMAIN = "episcopalhighschool.org";

// OAuth callback for teachers. Exchanges code → session, enforces the EHS
// Workspace domain, upserts the teachers row, redirects to `next` (or
// /dashboard).
//
// The `hd` OAuth hint isn't enforcement — a user can switch accounts mid-flow.
// We re-check the email domain here and sign them out if it doesn't match.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = request.nextUrl.searchParams.get("next") ?? "/dashboard";

  if (!code) return redirectWithError(request, "missing_code");

  const supabase = await getServerDbClient();
  const { error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return redirectWithError(request, exchangeError.message);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return redirectWithError(request, "no_user");
  }

  const email = user.email.toLowerCase();
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    await supabase.auth.signOut();
    return redirectWithError(request, "domain_not_allowed");
  }

  const googleIdentity = user.identities?.find((i) => i.provider === "google");
  const googleSub =
    (googleIdentity?.identity_data?.sub as string | undefined) ?? null;

  const meta = user.user_metadata ?? {};
  const displayName =
    (meta.full_name as string | undefined) ??
    (meta.name as string | undefined) ??
    email.split("@")[0]!;

  // Service-role upsert — teachers has no INSERT policy by design.
  try {
    const admin = createAdminDbClient();
    const { error: upsertError } = await admin
      .from("teachers")
      .upsert(
        {
          auth_user_id: user.id,
          email,
          display_name: displayName,
          google_sub: googleSub,
        },
        { onConflict: "auth_user_id" }
      )
      .select("id")
      .single();
    if (upsertError) {
      return redirectWithError(request, upsertError.message);
    }
  } catch (err) {
    return redirectWithError(request, (err as Error).message);
  }

  const dest = request.nextUrl.clone();
  dest.pathname = next.startsWith("/") ? next : "/dashboard";
  dest.search = "";
  return NextResponse.redirect(dest);
}

function redirectWithError(request: NextRequest, message: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("auth_error", message);
  return NextResponse.redirect(url);
}
