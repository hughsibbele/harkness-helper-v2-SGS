import { NextResponse, type NextRequest } from "next/server";
import { createProxyDbClient } from "@/lib/supabase/proxy";

// Auth proxy: refreshes the Supabase session on every request and gates
// /dashboard/* and /admin/* on a logged-in user.
//
// Per Next 16 docs this is an OPTIMISTIC check — it only reads the session
// cookie. Real authorization happens close to data in getCurrentTeacher() /
// getCurrentAdminEmail() inside the protected layouts.
export async function proxy(request: NextRequest) {
  const { supabase, getResponse } = createProxyDbClient(request);

  // Touching getUser() refreshes the session cookie if the access token is
  // close to expiring. Don't put any code between createProxyDbClient and
  // this call — Supabase docs warn that doing so can desync the response.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected =
    path.startsWith("/dashboard") || path.startsWith("/admin");

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  return getResponse();
}

export const config = {
  // Run on everything except static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp)).*)",
  ],
};
