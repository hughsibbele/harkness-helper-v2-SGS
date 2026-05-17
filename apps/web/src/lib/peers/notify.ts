import { createAdminDbClient } from "@harkness-helper/db/admin";
import type { Json } from "@harkness-helper/db";
import { buildHarknessEnvelopeForCanvasIds } from "./envelope";

const TIMEOUT_MS = 5_000;

type AttemptResult =
  | { canvas_user_id: string; ok: true }
  | {
      canvas_user_id: string;
      ok: false;
      status?: number;
      error: string;
    };

export type PushOutcome =
  | { kind: "skipped"; reason: string }
  | {
      kind: "complete";
      posted_for: string[];
      failed: { canvas_user_id: string; status?: number; error: string }[];
      attempted_at: string;
    };

/**
 * Fan out one POST per participant in the discussion to
 * `<SUPER_GRADER_API_URL>/api/ingest/harkness`. Super-grader's `peer_results`
 * is keyed per-student, not per-discussion — every participant gets their
 * own row.
 *
 * Best-effort by design: transient SG outages do not raise. Per-attempt
 * failures are persisted to `discussions.super_grader_response` for a future
 * retry surface, and `discussions.super_grader_post_status` flips to
 * 'error'. On full success: status → 'posted' AND `discussions.state` →
 * 'posted_to_super_grader'.
 *
 * Silent no-op when SUPER_GRADER_API_URL / SUPER_GRADER_INGEST_TOKEN /
 * NEXT_PUBLIC_APP_URL is unset (local/preview shape where SG isn't deployed
 * or this satellite isn't reachable from the public internet).
 */
export async function pushDiscussionToSuperGrader(
  discussionId: string,
): Promise<PushOutcome> {
  const ingestUrl = process.env.SUPER_GRADER_API_URL;
  const ingestToken = process.env.SUPER_GRADER_INGEST_TOKEN;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!ingestUrl || !ingestToken || !appUrl) {
    return {
      kind: "skipped",
      reason:
        "SUPER_GRADER_API_URL / SUPER_GRADER_INGEST_TOKEN / NEXT_PUBLIC_APP_URL unset",
    };
  }

  const admin = createAdminDbClient();

  // 1. Load the discussion + its participants' canvas_user_ids.
  let canvasAssignmentId: string;
  let canvasUserIds: string[];
  try {
    const { data: discussion, error: discussionErr } = await admin
      .from("discussions")
      .select("canvas_assignment_id")
      .eq("id", discussionId)
      .single();
    if (discussionErr || !discussion) {
      throw new Error(discussionErr?.message ?? "discussion not found");
    }
    canvasAssignmentId = discussion.canvas_assignment_id;

    const { data: participations, error: participationsErr } = await admin
      .from("participations")
      .select("students!inner ( canvas_user_id )")
      .eq("discussion_id", discussionId);
    if (participationsErr) throw new Error(participationsErr.message);

    type Row = {
      students:
        | { canvas_user_id: string }
        | { canvas_user_id: string }[]
        | null;
    };
    const seen = new Set<string>();
    canvasUserIds = ((participations ?? []) as unknown as Row[])
      .map((r) => {
        const s = Array.isArray(r.students) ? r.students[0] : r.students;
        return s?.canvas_user_id ?? null;
      })
      .filter((id): id is string => {
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attemptedAt = new Date().toISOString();
    await admin
      .from("discussions")
      .update({
        super_grader_post_status: "error",
        super_grader_response: {
          posted_for: [],
          failed: [{ canvas_user_id: "(load)", error: message }],
          attempted_at: attemptedAt,
        },
      })
      .eq("id", discussionId);
    return {
      kind: "complete",
      posted_for: [],
      failed: [{ canvas_user_id: "(load)", error: message }],
      attempted_at: attemptedAt,
    };
  }

  // 2. Fan out per-participant POSTs in parallel.
  const attempts = await Promise.all(
    canvasUserIds.map(
      async (canvasUserId): Promise<AttemptResult> => {
        try {
          const envelope = await buildHarknessEnvelopeForCanvasIds(
            canvasUserId,
            canvasAssignmentId,
          );
          if (!envelope) {
            return {
              canvas_user_id: canvasUserId,
              ok: false,
              error: "envelope build returned null (no transcribed discussion)",
            };
          }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
          try {
            const res = await fetch(`${ingestUrl}/api/ingest/harkness`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${ingestToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(envelope),
              signal: controller.signal,
            });
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              return {
                canvas_user_id: canvasUserId,
                ok: false,
                status: res.status,
                error: body.slice(0, 500) || `HTTP ${res.status}`,
              };
            }
            return { canvas_user_id: canvasUserId, ok: true };
          } finally {
            clearTimeout(timeout);
          }
        } catch (err) {
          return {
            canvas_user_id: canvasUserId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    ),
  );

  const postedFor = attempts.filter((a) => a.ok).map((a) => a.canvas_user_id);
  const failed = attempts
    .filter((a): a is Extract<AttemptResult, { ok: false }> => !a.ok)
    .map(({ canvas_user_id, status, error }) => ({
      canvas_user_id,
      status,
      error,
    }));
  const attemptedAt = new Date().toISOString();

  // 3. Persist status + diagnostics. State transitions to
  //    'posted_to_super_grader' only if every participant succeeded.
  const allOk = failed.length === 0 && postedFor.length > 0;
  const update: {
    super_grader_post_status: "posted" | "error" | "pending";
    super_grader_response: Json;
    state?: "posted_to_super_grader";
  } = {
    super_grader_post_status: allOk
      ? "posted"
      : failed.length > 0
        ? "error"
        : "pending",
    super_grader_response: {
      posted_for: postedFor,
      failed,
      attempted_at: attemptedAt,
    } as Json,
  };
  if (allOk) update.state = "posted_to_super_grader";

  await admin.from("discussions").update(update).eq("id", discussionId);

  return {
    kind: "complete",
    posted_for: postedFor,
    failed,
    attempted_at: attemptedAt,
  };
}
