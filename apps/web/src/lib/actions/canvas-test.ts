"use server";

import {
  CanvasError,
  getSelf,
  normalizeHost,
  type CanvasConfig,
} from "@harkness-helper/canvas";
import { getCurrentTeacher } from "@/lib/auth/teacher";

export type TestCanvasResult =
  | { ok: true; userName: string; userId: number; host: string }
  | { ok: false; error: string };

/**
 * Verify the shared Canvas token still works by calling /users/self.
 *
 * HH is single-tenant by design (one shared CANVAS_API_TOKEN env var on
 * Vercel rather than per-teacher tokens). When the key rotates or the
 * token expires, sync silently fails — surface a Test button on the
 * setup page so the failure mode is one click away.
 */
export async function testCanvasConnection(): Promise<TestCanvasResult> {
  await getCurrentTeacher(); // ensure signed in
  const rawHost = process.env.CANVAS_BASE_URL;
  const token = process.env.CANVAS_API_TOKEN;
  if (!rawHost) return { ok: false, error: "CANVAS_BASE_URL is not set." };
  if (!token) return { ok: false, error: "CANVAS_API_TOKEN is not set." };

  let config: CanvasConfig;
  try {
    config = { host: normalizeHost(rawHost), token };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid CANVAS_BASE_URL.",
    };
  }

  try {
    const user = await getSelf(config);
    return {
      ok: true,
      userName: user.name,
      userId: user.id,
      host: config.host,
    };
  } catch (err) {
    if (err instanceof CanvasError) {
      return { ok: false, error: err.message };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown Canvas error.",
    };
  }
}
