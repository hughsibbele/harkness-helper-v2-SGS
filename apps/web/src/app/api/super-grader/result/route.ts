import { NextResponse } from "next/server";
import { checkSuperGraderBearer } from "@/lib/peers/auth";
import { buildHarknessEnvelopeForCanvasIds } from "@/lib/peers/envelope";

export async function GET(request: Request) {
  const authFail = checkSuperGraderBearer(request);
  if (authFail) return authFail;

  const url = new URL(request.url);
  const canvasUserId = url.searchParams.get("canvas_user_id");
  const canvasAssignmentId = url.searchParams.get("canvas_assignment_id");
  if (!canvasUserId || !canvasAssignmentId) {
    return NextResponse.json(
      { error: "canvas_user_id and canvas_assignment_id are required" },
      { status: 400 },
    );
  }

  const envelope = await buildHarknessEnvelopeForCanvasIds(
    canvasUserId,
    canvasAssignmentId,
  );
  if (!envelope) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Short cache: super-grader pulls this on view, but state can change
  // between loads (re-record, edits). 30s gives the burst-fetch case a
  // free ride without holding stale data for long.
  return NextResponse.json(envelope, {
    headers: { "Cache-Control": "private, max-age=30" },
  });
}
