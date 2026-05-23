import { NextResponse, type NextRequest } from "next/server";
import { isAdmin } from "@/lib/auth/admin";
import { runSweep } from "@/app/api/cron/sweep-discussions/route";

// M6.22 Phase 0c — manual sweep trigger from /admin/retention.
//
// Re-uses the same logic as the daily cron, but auth-gated to admins
// instead of requiring the CRON_SECRET bearer. The audit row is tagged
// triggered_by='admin_manual' so the page can distinguish operator-runs
// from scheduled runs.

export async function POST(request: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json(
      { ok: false, error: "admin only" },
      { status: 403 },
    );
  }
  return runSweep(request, "admin_manual");
}
