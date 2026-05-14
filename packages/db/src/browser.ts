// Supabase client for use inside React Client Components ("use client").
// Lives in the browser; reads the publishable key only (no service role).

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { publicSupabaseUrl, publishableKey } from "./env";

export function createBrowserDbClient() {
  return createBrowserClient<Database>(publicSupabaseUrl(), publishableKey());
}
