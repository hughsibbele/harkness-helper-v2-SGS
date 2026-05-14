import "server-only";
import { cookies } from "next/headers";
import { createServerDbClient } from "@harkness-helper/db/server";

// Supabase client for Server Components, Server Actions, and Route Handlers.
// Reads/writes the auth cookies via Next 16's async cookies() API.
export async function getServerDbClient() {
  const cookieStore = await cookies();
  return createServerDbClient({
    getAll() {
      return cookieStore.getAll();
    },
    setAll(toSet) {
      // In a Server Component render pass, cookieStore.set throws — Next
      // doesn't allow modifying cookies during streaming. The Supabase SSR
      // client calls setAll on token refresh; swallow the throw — the next
      // Server Action / Route Handler / proxy pass will refresh again.
      try {
        for (const c of toSet) {
          cookieStore.set(c.name, c.value, c.options);
        }
      } catch {
        /* read-only context */
      }
    },
  });
}
