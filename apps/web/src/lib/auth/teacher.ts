import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { Tables } from "@harkness-helper/db";
import { getServerDbClient } from "@/lib/supabase/server";

export type Teacher = Tables<"teachers">;

// Reads the current auth session and joins to the teachers row. Redirects
// to "/" if there's no session or no teacher row. Memoized per render via
// React's cache().
//
// First-login upsert into teachers happens in /auth/callback — by the time
// any page calls getCurrentTeacher(), the row should exist. If it somehow
// doesn't (admin deleted it, race), redirect to "/" too.
export const getCurrentTeacher = cache(async (): Promise<Teacher> => {
  const supabase = await getServerDbClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/");

  const { data: teacher } = await supabase
    .from("teachers")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!teacher) redirect("/");

  return teacher;
});
