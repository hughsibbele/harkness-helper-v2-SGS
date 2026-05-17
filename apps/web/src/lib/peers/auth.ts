import { NextResponse } from "next/server";

/**
 * Bearer-auth gate for /api/super-grader/* endpoints. Returns null when the
 * request is authorized; returns a NextResponse to bail with otherwise.
 *
 * Missing env var → 500 (loud). The contract treats unconfigured satellites
 * as a setup error super-grader needs to flag, not as a silent 401 that
 * looks like a bad credential. Bad/missing token → 401 per contract.
 */
export function checkSuperGraderBearer(request: Request): NextResponse | null {
  const expected = process.env.HARKNESS_API_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "HARKNESS_API_TOKEN is not configured on this satellite." },
      { status: 500 },
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
