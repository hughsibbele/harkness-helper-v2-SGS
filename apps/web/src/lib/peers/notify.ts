import { createAdminDbClient } from "@harkness-helper/db/admin";
import type { Json } from "@harkness-helper/db";
import { buildHarknessEnvelopeForCanvasIds } from "./envelope";

const TIMEOUT_MS = 5_000;

type AttemptResult =
  | { canvas_user_id: string; participation_id: string; ok: true }
  | {
      canvas_user_id: string;
      participation_id: string;
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
 * results are persisted to BOTH:
 *   - participations.super_grader_post_{status,attempted_at,error} — the
 *     per-participation record. M6.22 Phase 2 — enables a future retry to
 *     filter just the failed participants without parsing the aggregate
 *     JSONB.
 *   - discussions.super_grader_response (aggregate JSONB) +
 *     super_grader_post_status — the existing aggregate shape, derived
 *     from per-participation outcomes.
 *
 * Aggregate state transitions:
 *   - All participations succeed AND state='transcribed' (fenced) →
 *     state='posted_to_super_grader'. The fence prevents a stale push
 *     from clobbering a row that, say, retention archived in the
 *     meantime.
 *   - Any participation fails → status='error', state stays 'transcribed'.
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

  // 1. Load the discussion + its participations (with canvas_user_ids).
  //    Per-participation join lets us write per-participation status
  //    without a second lookup.
  let canvasAssignmentId: string;
  type Participant = { participation_id: string; canvas_user_id: string };
  let participants: Participant[];
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
      .select("id, students!inner ( canvas_user_id )")
      .eq("discussion_id", discussionId);
    if (participationsErr) throw new Error(participationsErr.message);

    type Row = {
      id: string;
      students:
        | { canvas_user_id: string }
        | { canvas_user_id: string }[]
        | null;
    };
    const seen = new Set<string>();
    participants = ((participations ?? []) as unknown as Row[])
      .map((r) => {
        const s = Array.isArray(r.students) ? r.students[0] : r.students;
        const cuid = s?.canvas_user_id ?? null;
        if (!cuid || seen.has(cuid)) return null;
        seen.add(cuid);
        return { participation_id: r.id, canvas_user_id: cuid };
      })
      .filter((r): r is Participant => r !== null);
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
        } as Json,
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
    participants.map(
      async ({ participation_id, canvas_user_id }): Promise<AttemptResult> => {
        try {
          const envelope = await buildHarknessEnvelopeForCanvasIds(
            canvas_user_id,
            canvasAssignmentId,
          );
          if (!envelope) {
            return {
              canvas_user_id,
              participation_id,
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
                canvas_user_id,
                participation_id,
                ok: false,
                status: res.status,
                error: body.slice(0, 500) || `HTTP ${res.status}`,
              };
            }
            return { canvas_user_id, participation_id, ok: true };
          } finally {
            clearTimeout(timeout);
          }
        } catch (err) {
          return {
            canvas_user_id,
            participation_id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    ),
  );

  // 3a. Record per-participation outcomes. M6.22 Phase 2 — a future
  //     retry path can filter participations.super_grader_post_status
  //     ='failed' instead of parsing the aggregate JSONB.
  const attemptedAt = new Date().toISOString();
  await Promise.all(
    attempts.map((a) =>
      admin
        .from("participations")
        .update({
          super_grader_post_status: a.ok ? "ok" : "failed",
          super_grader_post_attempted_at: attemptedAt,
          super_grader_post_error: a.ok ? null : a.error.slice(0, 500),
        })
        .eq("id", a.participation_id),
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

  // 3b. Aggregate state transitions. The aggregate flip to
  //     'posted_to_super_grader' is fenced on state='transcribed' so a
  //     stale push (or a retention archive in flight) can't clobber a
  //     row that's already moved past. M6.22 Phase 2 state-fence.
  const allOk = failed.length === 0 && postedFor.length > 0;
  await admin
    .from("discussions")
    .update({
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
    })
    .eq("id", discussionId);

  if (allOk) {
    await admin
      .from("discussions")
      .update({ state: "posted_to_super_grader" })
      .eq("id", discussionId)
      .eq("state", "transcribed");
  }

  return {
    kind: "complete",
    posted_for: postedFor,
    failed,
    attempted_at: attemptedAt,
  };
}
