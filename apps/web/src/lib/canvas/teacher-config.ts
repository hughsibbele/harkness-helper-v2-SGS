import "server-only";
import {
  type CanvasConfig,
  normalizeHost,
} from "@harkness-helper/canvas";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { decryptSecret } from "@/lib/crypto/secret";

// Typed error so call sites can render a "Canvas not connected" hint
// instead of a 500. Always carries the teacher id so the Inngest worker
// can log a useful breadcrumb.
export class CanvasNotConnectedError extends Error {
  constructor(public teacherId: string, message?: string) {
    super(
      message ??
        `Teacher ${teacherId} has no Canvas token configured. Connect via /dashboard/setup.`,
    );
    this.name = "CanvasNotConnectedError";
  }
}

/**
 * Load the per-teacher Canvas {host, token} from the encrypted column on
 * `teachers`. Uses the admin client because:
 *
 *  - the Inngest worker (`postDiscussionDraftComments`) has no user session;
 *  - the user-scoped client can't read `canvas_token_encrypted` either way
 *    — Phase 0b's RLS revoked plaintext exposure of the encrypted columns
 *    to authenticated.
 *
 * Throws `CanvasNotConnectedError` when the teacher hasn't connected yet,
 * which call sites should catch and surface as a UI prompt rather than a
 * server error.
 */
export async function loadTeacherCanvasConfig(
  teacherId: string,
): Promise<CanvasConfig> {
  const admin = createAdminDbClient();
  const { data, error } = await admin
    .from("teachers")
    .select("canvas_token_encrypted, canvas_host")
    .eq("id", teacherId)
    .single();

  if (error) {
    throw new Error(
      `Failed to load teacher ${teacherId} Canvas config: ${error.message}`,
    );
  }
  if (!data?.canvas_token_encrypted || !data.canvas_host) {
    throw new CanvasNotConnectedError(teacherId);
  }

  return {
    host: normalizeHost(data.canvas_host),
    token: decryptSecret(data.canvas_token_encrypted),
  };
}
