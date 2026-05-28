"use server";

import { CanvasError, getSelf } from "@harkness-helper/canvas";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import {
  CanvasNotConnectedError,
  loadTeacherCanvasConfig,
} from "@/lib/canvas/teacher-config";

export type TestCanvasResult =
  | { ok: true; userName: string; userId: number; host: string }
  | { ok: false; error: string };

/**
 * Verify the teacher's saved Canvas token still works by calling /users/self.
 *
 * Per-teacher tokens (M7.x) live on `teachers.canvas_token_encrypted`. When
 * the token rotates, expires, or has never been set, surface the failure
 * clearly so the teacher knows to re-paste it on /dashboard/setup.
 */
export async function testCanvasConnection(): Promise<TestCanvasResult> {
  const teacher = await getCurrentTeacher();

  let config;
  try {
    config = await loadTeacherCanvasConfig(teacher.id);
  } catch (err) {
    if (err instanceof CanvasNotConnectedError) {
      return {
        ok: false,
        error:
          "Canvas not connected. Paste your API token in the section above.",
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Canvas config error.",
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
