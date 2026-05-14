// Centralized env-var reading with clear, actionable error messages.

export function publicSupabaseUrl(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!v) {
    throw new Error(
      "db: NEXT_PUBLIC_SUPABASE_URL is not set. " +
        "Add it to apps/web/.env.local and the Vercel project env."
    );
  }
  return v;
}

export function publishableKey(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!v) {
    throw new Error(
      "db: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set. " +
        "Add it to apps/web/.env.local and the Vercel project env."
    );
  }
  return v;
}

export function serviceRoleKey(): string {
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!v) {
    throw new Error(
      "db: SUPABASE_SERVICE_ROLE_KEY is not set. " +
        "Pull from Supabase dashboard → Settings → API. " +
        "Server-only — never expose to the client."
    );
  }
  return v;
}
