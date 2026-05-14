import "server-only";
import { cache } from "react";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getServerDbClient } from "@/lib/supabase/server";

// Admin gatekeeper. Returns the logged-in user's email iff they have an
// active row in the `admins` table. Self-bootstraps the FIRST admin from
// INITIAL_ADMIN_EMAIL when the table is empty — idempotent, won't re-fire
// once any row exists.
//
// Returns null for unauthenticated users and for teachers who aren't admins;
// callers (e.g. /admin/layout.tsx) decide whether to redirect.
export const getCurrentAdminEmail = cache(async (): Promise<string | null> => {
  const supabase = await getServerDbClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) return null;

  const email = user.email.toLowerCase();
  const admin = createAdminDbClient();

  const { data: row } = await admin
    .from("admins")
    .select("email, active")
    .eq("email", email)
    .maybeSingle();

  if (row && row.active) return email;
  if (row && !row.active) return null;

  // No row: self-bootstrap if this user matches INITIAL_ADMIN_EMAIL and the
  // admins table is currently empty.
  const initial = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  if (!initial || initial !== email) return null;

  const { count } = await admin
    .from("admins")
    .select("email", { count: "exact", head: true });
  if (count && count > 0) return null;

  await admin.from("admins").insert({
    email,
    granted_by_email: "system",
    active: true,
  });

  return email;
});

export async function isAdmin(): Promise<boolean> {
  return (await getCurrentAdminEmail()) !== null;
}
