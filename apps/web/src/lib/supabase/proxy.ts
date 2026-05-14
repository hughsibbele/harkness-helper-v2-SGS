import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@harkness-helper/db";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Supabase client for use inside `proxy.ts`. The proxy can't import the
// `next/headers` cookies() API; it works off the request/response pair.
//
// Returns the supabase client plus a getter for the response that the proxy
// must return — `setAll` rebuilds the response so refreshed auth cookies
// land on the way out.
export function createProxyDbClient(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(toSet: CookieToSet[]) {
          for (const c of toSet) {
            request.cookies.set(c.name, c.value);
          }
          response = NextResponse.next({ request });
          for (const c of toSet) {
            response.cookies.set(c.name, c.value, c.options);
          }
        },
      },
    }
  );

  return {
    supabase,
    getResponse: () => response,
  };
}
