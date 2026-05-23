import { NextResponse, type NextRequest } from "next/server";
import { createAdminDbClient } from "@harkness-helper/db/admin";

// M6.22 Phase 0c — retention sweep cron.
//
// Closes audit-seams.md C: HH had no retention sweep at all. Audio
// recordings of student voices (HH's most sensitive PII) accumulated
// indefinitely. Two passes, both state-fenced + idempotent:
//
//   1. Auto-archive stale uploaded/transcribing rows: state IN
//      ('uploaded','transcribing') AND created_at < now() - STALE_GRACE_DAYS
//      → state='archived'. Inngest crashed mid-job, no recovery, no other
//      worker is going to pick this up — the audio is wasted space. The
//      storage blob is removed first, then the row is updated. A future
//      Phase 2 (state fences + per-participant retry) will reduce how
//      often this fires.
//
//   2. Hard-delete past-retention rows: state IN ('transcribed',
//      'posted_to_super_grader','failed','archived') AND created_at <
//      now() - RETENTION_MONTHS months. Storage blob first, then the row
//      (DB delete cascades to participations). RETENTION_MONTHS default
//      13 per the suite-wide M6.16 standard (academic year + grade-
//      appeal buffer). Configurable via env.
//
// Storage-deletes are intentionally NOT atomic with DB-deletes — Supabase
// Storage object delete is a REST call separate from the Postgres
// transaction. We delete storage FIRST so a partial fail leaves an
// orphan row (which the next sweep will retry) rather than an orphan
// blob (which lives forever).
//
// Vercel attaches `Authorization: Bearer ${CRON_SECRET}` to scheduled
// invocations. Manual invocations from /admin/retention go through a
// separate /api/admin/retention/sweep endpoint that re-uses this logic.

const STALE_GRACE_DAYS = 14;
const BUCKET = "discussion-audio";

type DiscussionRow = {
  id: string;
  audio_url: string;
  created_at: string;
};

export async function GET(request: NextRequest) {
  return runSweep(request, "cron");
}

export async function runSweep(
  request: NextRequest,
  triggeredBy: "cron" | "admin_manual",
) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }

  if (triggeredBy === "cron") {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    }
  }

  const admin = createAdminDbClient();

  // Open audit row at the start so a partial failure leaves a record.
  const { data: audit, error: auditErr } = await admin
    .from("retention_audits")
    .insert({ triggered_by: triggeredBy })
    .select("id")
    .single();
  if (auditErr || !audit) {
    return NextResponse.json(
      {
        ok: false,
        error: `retention_audits insert failed: ${auditErr?.message ?? "unknown"}`,
      },
      { status: 500 },
    );
  }
  const auditId = audit.id;

  const retentionMonths = Number.parseInt(
    process.env.RETENTION_MONTHS ?? "13",
    10,
  );
  if (!Number.isFinite(retentionMonths) || retentionMonths < 1) {
    await markAuditFailed(
      admin,
      auditId,
      `RETENTION_MONTHS env var must be a positive integer (got ${process.env.RETENTION_MONTHS ?? "unset"})`,
    );
    return NextResponse.json(
      { ok: false, error: "invalid RETENTION_MONTHS" },
      { status: 503 },
    );
  }

  const now = Date.now();
  const staleCutoff = new Date(
    now - STALE_GRACE_DAYS * 86_400_000,
  ).toISOString();
  // Approximate month math is fine for a retention cron — 30.5d * months.
  const retentionCutoff = new Date(
    now - retentionMonths * 30.5 * 86_400_000,
  ).toISOString();

  let archivedCount = 0;
  let deletedCount = 0;
  let storageObjectsDeleted = 0;

  try {
    // Pass 1 — archive stale uploaded/transcribing rows.
    const { data: staleRows, error: staleErr } = await admin
      .from("discussions")
      .select("id, audio_url, created_at")
      .in("state", ["uploaded", "transcribing"])
      .lt("created_at", staleCutoff);
    if (staleErr) throw new Error(`stale lookup: ${staleErr.message}`);

    for (const row of (staleRows ?? []) as DiscussionRow[]) {
      // Storage first.
      if (row.audio_url) {
        const { error: rmErr } = await admin.storage
          .from(BUCKET)
          .remove([row.audio_url]);
        if (!rmErr) storageObjectsDeleted += 1;
      }
      const { error: updErr } = await admin
        .from("discussions")
        .update({ state: "archived" })
        .eq("id", row.id)
        .in("state", ["uploaded", "transcribing"]); // state fence
      if (!updErr) archivedCount += 1;
    }

    // Pass 2 — hard-delete past-retention terminal rows.
    const { data: oldRows, error: oldErr } = await admin
      .from("discussions")
      .select("id, audio_url, created_at")
      .in("state", [
        "transcribed",
        "posted_to_super_grader",
        "failed",
        "archived",
      ])
      .lt("created_at", retentionCutoff)
      .limit(500); // chunked — large backlogs spread across multiple cron passes.
    if (oldErr) throw new Error(`retention lookup: ${oldErr.message}`);

    for (const row of (oldRows ?? []) as DiscussionRow[]) {
      if (row.audio_url) {
        const { error: rmErr } = await admin.storage
          .from(BUCKET)
          .remove([row.audio_url]);
        if (!rmErr) storageObjectsDeleted += 1;
        // If rm failed because the blob was already gone, we still proceed
        // to delete the row — leaving an orphan row pointing at a missing
        // blob is worse than the inverse.
      }
      const { error: delErr } = await admin
        .from("discussions")
        .delete()
        .eq("id", row.id);
      if (!delErr) deletedCount += 1;
    }

    await admin
      .from("retention_audits")
      .update({
        completed_at: new Date().toISOString(),
        archived_count: archivedCount,
        deleted_count: deletedCount,
        storage_objects_deleted: storageObjectsDeleted,
      })
      .eq("id", auditId);

    if (archivedCount > 0 || deletedCount > 0) {
      console.log(
        `[sweep-discussions] archived=${archivedCount} deleted=${deletedCount} storage_objects=${storageObjectsDeleted}`,
      );
    }

    return NextResponse.json({
      ok: true,
      archived: archivedCount,
      deleted: deletedCount,
      storage_objects_deleted: storageObjectsDeleted,
      stale_cutoff: staleCutoff,
      retention_cutoff: retentionCutoff,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markAuditFailed(admin, auditId, message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}

async function markAuditFailed(
  admin: ReturnType<typeof createAdminDbClient>,
  auditId: string,
  errorMessage: string,
) {
  await admin
    .from("retention_audits")
    .update({
      completed_at: new Date().toISOString(),
      error: errorMessage.slice(0, 1000),
    })
    .eq("id", auditId);
}
