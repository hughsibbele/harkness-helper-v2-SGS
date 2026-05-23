import { NextResponse, type NextRequest } from "next/server";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { encryptSecret } from "@/lib/crypto/secret";
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
  const { data: exchanged, error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return redirectWithError(request, exchangeError.message);
  }

  const session = exchanged.session;
  const user = exchanged.user;

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
  // We also capture Google OAuth provider tokens so server-side Drive/Docs
  // calls work later. Refresh_token is only returned on first consent per
  // Google's behavior — preserve any existing one if this sign-in didn't
  // include a fresh one.
  const providerToken = session?.provider_token ?? null;
  const providerRefreshToken = session?.provider_refresh_token ?? null;
  // Supabase's session.expires_in is for the Supabase JWT, not the Google
  // token. Google access tokens are 1h; conservatively expire ours at
  // 55min so we refresh before the boundary.
  const tokenExpiresAt = providerToken
    ? new Date(Date.now() + 55 * 60 * 1000).toISOString()
    : null;

  try {
    const admin = createAdminDbClient();
    // M6.22 Phase 0b — Google tokens are encrypted at rest with
    // TEACHER_GTOKEN_ENC_KEY. Write only to the encrypted columns and
    // explicitly null the plaintext columns on every write so a returning
    // teacher's row converges to encrypted-only automatically. If the env
    // var isn't set, `encryptSecret` throws and the callback fails loudly
    // (correct posture — silent fallback to plaintext would re-open the
    // leak the migration closes).
    const tokenUpdates: Record<string, string | null> = {};
    if (providerToken) {
      tokenUpdates.google_access_token_encrypted = encryptSecret(providerToken);
      tokenUpdates.google_access_token = null;
    }
    if (tokenExpiresAt) {
      tokenUpdates.google_token_expires_at = tokenExpiresAt;
    }
    if (providerRefreshToken) {
      tokenUpdates.google_refresh_token_encrypted =
        encryptSecret(providerRefreshToken);
      tokenUpdates.google_refresh_token = null;
    }
    const { error: upsertError } = await admin
      .from("teachers")
      .upsert(
        {
          auth_user_id: user.id,
          email,
          display_name: displayName,
          google_sub: googleSub,
          ...tokenUpdates,
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
