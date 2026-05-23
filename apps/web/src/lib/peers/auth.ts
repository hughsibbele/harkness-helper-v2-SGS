import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Bearer-auth gate for /api/super-grader/* endpoints. Returns null when the
 * request is authorized; returns a NextResponse to bail with otherwise.
 *
 * Missing env var → 503 (loud). The contract treats unconfigured satellites
 * as a setup error super-grader needs to flag, not as a silent 401 that
 * looks like a bad credential.
 *
 * Bad/missing token → 401 per contract.
 *
 * M6.22 Phase 0b — token compare uses `crypto.timingSafeEqual` with a
 * length pre-check (timingSafeEqual throws on mismatched lengths). The
 * prior `!==` compare leaked the token's length and prefix byte-by-byte
 * to a timing-oracle attacker (audit-seams.md C; audit-auth-rls.md H2).
 */
export function checkSuperGraderBearer(request: Request): NextResponse | null {
  const expected = process.env.HARKNESS_API_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "HARKNESS_API_TOKEN is not configured on this satellite." },
      { status: 503 },
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supplied = match[1];
  if (!constantTimeStringEqual(supplied, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch — we still want a constant-time
  // verdict in that case, so compare equal-length zero-buffers and report
  // false. A length difference is a known oracle either way; the goal is
  // to not leak more than that.
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
