"use server";

import { revalidatePath } from "next/cache";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentAdminEmail } from "@/lib/auth/admin";
import type { GrantAdminResult, RevokeAdminResult } from "./admins.types";

export async function grantAdmin(rawEmail: string): Promise<GrantAdminResult> {
  const granter = await getCurrentAdminEmail();
  if (!granter) return { ok: false, message: "Admin only" };

  const email = rawEmail.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, message: "Enter a valid email address" };
  }

  const requiredDomain = process.env.ADMIN_EMAIL_DOMAIN?.trim().toLowerCase();
  if (requiredDomain && !email.endsWith(`@${requiredDomain}`)) {
    return {
      ok: false,
      message: `Admin emails must be on @${requiredDomain}`,
    };
  }

  const admin = createAdminDbClient();
  const { error } = await admin.from("admins").upsert(
    {
      email,
      granted_by_email: granter,
      active: true,
    },
    { onConflict: "email" }
  );
  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin/admins");
  return { ok: true };
}

export async function revokeAdmin(
  rawEmail: string
): Promise<RevokeAdminResult> {
  const granter = await getCurrentAdminEmail();
  if (!granter) return { ok: false, message: "Admin only" };

  const email = rawEmail.trim().toLowerCase();
  if (!email) return { ok: false, message: "Email is required" };

  const admin = createAdminDbClient();

  const { data: target } = await admin
    .from("admins")
    .select("email, active")
    .eq("email", email)
    .maybeSingle();

  if (!target || !target.active) {
    return {
      ok: false,
      message: "That admin doesn't exist or is already revoked",
    };
  }

  // Last-admin-lockout guard. If there's only one active admin left and it's
  // this email, refuse — bricking the admin layer is irreversible from the
  // UI (you'd have to bootstrap via INITIAL_ADMIN_EMAIL again, but only if
  // the table were empty, which it isn't).
  const { count } = await admin
    .from("admins")
    .select("email", { count: "exact", head: true })
    .eq("active", true);

  if (count !== null && count <= 1) {
    return {
      ok: false,
      message: "Can't revoke the last active admin",
    };
  }

  const { error } = await admin
    .from("admins")
    .update({ active: false })
    .eq("email", email);

  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin/admins");
  return { ok: true };
}
