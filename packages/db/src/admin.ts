// Service-role Supabase client. Bypasses RLS — server-only, never expose to
// the client. Use sparingly: only for code paths that must operate outside
// the calling user's row scope (first-admin bootstrap, Inngest jobs, the
// teacher upsert in /auth/callback, the school-wide Canvas-cache sync).

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { publicSupabaseUrl, serviceRoleKey } from "./env";

export function createAdminDbClient() {
  return createClient<Database>(publicSupabaseUrl(), serviceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
