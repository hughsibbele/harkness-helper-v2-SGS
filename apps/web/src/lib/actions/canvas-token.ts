"use server";

import { revalidatePath } from "next/cache";
import { CanvasError, getSelf } from "@harkness-helper/canvas";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { encryptSecret } from "@/lib/crypto/secret";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { EHS_CANVAS_HOST, type ConnectState } from "./canvas-token.types";

export async function connectCanvas(
  _prev: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const token = (formData.get("token") ?? "").toString().trim();
  if (!token) {
    return { status: "error", message: "Paste a Canvas API token first." };
  }

  let canvasUser;
  try {
    canvasUser = await getSelf({ host: EHS_CANVAS_HOST, token });
  } catch (err) {
    if (err instanceof CanvasError) {
      return { status: "error", message: err.message };
    }
    return {
      status: "error",
      message: "Couldn't reach Canvas. Check your connection and try again.",
    };
  }

  const teacher = await getCurrentTeacher();

  // RLS (20260522130001_tighten_teachers_update_rls) restricts authenticated
  // UPDATEs on teachers to (display_name, gemini_daily_cap). Token storage
  // goes via the service-role admin client, bypassing RLS + column grants.
  const admin = createAdminDbClient();
  const { error } = await admin
    .from("teachers")
    .update({
      canvas_token_encrypted: encryptSecret(token),
      canvas_host: EHS_CANVAS_HOST,
    })
    .eq("id", teacher.id);

  if (error) {
    return {
      status: "error",
      message: `Token verified, but saving it failed: ${error.message}`,
    };
  }

  revalidatePath("/dashboard/setup");
  revalidatePath("/dashboard");
  return { status: "ok", canvasUserName: canvasUser.name };
}

export async function disconnectCanvas(): Promise<void> {
  const teacher = await getCurrentTeacher();
  const admin = createAdminDbClient();
  await admin
    .from("teachers")
    .update({
      canvas_token_encrypted: null,
      canvas_host: null,
    })
    .eq("id", teacher.id);
  revalidatePath("/dashboard/setup");
  revalidatePath("/dashboard");
}
