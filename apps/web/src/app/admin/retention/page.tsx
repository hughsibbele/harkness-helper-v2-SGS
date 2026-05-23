import { createAdminDbClient } from "@harkness-helper/db/admin";
import { SweepNowButton } from "./SweepNowButton";

// M6.22 Phase 0c — minimum-viable retention console.
//
// Shows the operator: (1) headline counts so they can confirm data is
// accumulating, (2) the most recent /api/cron/sweep-discussions audit row
// so they can confirm the cron is firing, (3) a manual "Sweep now"
// button that runs the same logic out-of-band.
//
// CSV export + per-row chunked delete UI are tracked in REMEDIATION_PLAN
// Phase 6 — not blocking the FERPA-shaped gap this page closes.

export const dynamic = "force-dynamic";

export default async function AdminRetentionPage() {
  const admin = createAdminDbClient();

  const [{ count: discussionsTotal }, { data: oldestRow }, { data: lastAudit }] =
    await Promise.all([
      admin.from("discussions").select("id", { count: "exact", head: true }),
      admin
        .from("discussions")
        .select("created_at")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      admin
        .from("retention_audits")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const retentionMonths = Number.parseInt(
    process.env.RETENTION_MONTHS ?? "13",
    10,
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Retention</h1>
        <p className="mt-1 text-sm text-cool-gray">
          Discussions and their audio recordings are purged on a daily cron
          (<code className="font-mono text-xs">/api/cron/sweep-discussions</code>{" "}
          at 03:00 UTC). Two passes: stuck uploads &gt; 14 days are archived;
          terminal-state rows &gt; {retentionMonths} months are hard-deleted
          along with their audio blob. Configurable via{" "}
          <code className="font-mono text-xs">RETENTION_MONTHS</code>.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Discussions total" value={discussionsTotal ?? 0} />
        <Stat
          label="Oldest discussion"
          value={
            oldestRow?.created_at
              ? new Date(oldestRow.created_at).toLocaleDateString()
              : "—"
          }
        />
        <Stat
          label="Retention window"
          value={`${retentionMonths} months`}
        />
      </div>

      <section className="space-y-3 rounded-md border border-stone-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-stone-900">
          Last sweep
        </h2>
        {lastAudit ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Row label="Started">
              {new Date(lastAudit.started_at).toLocaleString()}
            </Row>
            <Row label="Completed">
              {lastAudit.completed_at
                ? new Date(lastAudit.completed_at).toLocaleString()
                : "(in progress / failed)"}
            </Row>
            <Row label="Archived (stuck)">{lastAudit.archived_count}</Row>
            <Row label="Hard-deleted">{lastAudit.deleted_count}</Row>
            <Row label="Storage objects removed">
              {lastAudit.storage_objects_deleted}
            </Row>
            <Row label="Trigger">{lastAudit.triggered_by}</Row>
            {lastAudit.error ? (
              <div className="sm:col-span-2">
                <Row label="Error">
                  <span className="text-maroon">{lastAudit.error}</span>
                </Row>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm italic text-cool-gray">
            No sweep recorded yet. The cron fires at 03:00 UTC daily on
            production; you can also run it manually below.
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-md border border-stone-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-stone-900">
          Run a sweep now
        </h2>
        <p className="text-sm text-cool-gray">
          Triggers the same archive + hard-delete passes the daily cron
          runs. Useful for confirming the cron logic is wired correctly
          without waiting until 03:00 UTC. Deletes are permanent and
          state-fenced.
        </p>
        <SweepNowButton />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-cool-gray">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-stone-100 py-1 last:border-b-0">
      <dt className="text-cool-gray">{label}</dt>
      <dd className="font-medium text-stone-900">{children}</dd>
    </div>
  );
}
