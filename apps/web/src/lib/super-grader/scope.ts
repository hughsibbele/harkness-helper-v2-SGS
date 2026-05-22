import "server-only";

/**
 * Ask super-grader whether it is tracking this Canvas assignment.
 *
 * HH doesn't post to Canvas today (HH stores audio + transcripts + summaries
 * internally and ships them to super-grader via the existing
 * push-to-super-grader Inngest step). So for HH this is indicator-only:
 * the dashboard surfaces "↗ super-grader" next to discussions on in-scope
 * assignments so the teacher knows SG will collect this discussion's
 * transcript/summary alongside the essay. If HH ever adds a Canvas-write
 * path (e.g. M7.5 draft comment), gate that path on `in_scope === false`
 * the same way AID and HAH do.
 *
 * Fail-open: any error returns `{ in_scope: false }`. 5-min in-process
 * cache per assignment.
 */
export type SuperGraderScope = {
  in_scope: boolean;
  role: string | null;
};

type CacheEntry = { value: SuperGraderScope; expires: number };
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2500;

export function __resetSuperGraderScopeCache(): void {
  CACHE.clear();
}

export async function isAssignmentInSuperGraderScope(
  canvasAssignmentId: string | number | null | undefined,
): Promise<SuperGraderScope> {
  if (canvasAssignmentId == null) return { in_scope: false, role: null };
  const idStr = String(canvasAssignmentId);
  if (!idStr) return { in_scope: false, role: null };

  const cached = CACHE.get(idStr);
  if (cached && cached.expires > Date.now()) return cached.value;

  const baseUrl = process.env.SUPER_GRADER_API_URL?.replace(/\/$/, "");
  const token = process.env.SUPER_GRADER_INGEST_TOKEN;
  if (!baseUrl || !token) {
    return { in_scope: false, role: null };
  }

  const url = new URL(
    "/api/peers/harkness/assignment-status",
    baseUrl,
  );
  url.searchParams.set("canvas_assignment_id", idStr);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[sg-scope] non-2xx from super-grader for assignment ${idStr}: ${res.status}`,
      );
      return { in_scope: false, role: null };
    }
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") {
      return { in_scope: false, role: null };
    }
    const parsed: SuperGraderScope = {
      in_scope: Boolean((body as { in_scope?: unknown }).in_scope),
      role:
        typeof (body as { role?: unknown }).role === "string"
          ? ((body as { role: string }).role)
          : null,
    };
    CACHE.set(idStr, {
      value: parsed,
      expires: Date.now() + CACHE_TTL_MS,
    });
    return parsed;
  } catch (err) {
    console.warn(
      `[sg-scope] super-grader lookup failed for assignment ${idStr}: ${(err as Error).message}`,
    );
    return { in_scope: false, role: null };
  }
}

export async function bulkSuperGraderScope(
  canvasAssignmentIds: Array<string | number | null | undefined>,
): Promise<Map<string, SuperGraderScope>> {
  const unique = Array.from(
    new Set(
      canvasAssignmentIds
        .filter((id): id is string | number => id != null && id !== "")
        .map((id) => String(id)),
    ),
  );
  const results = await Promise.all(
    unique.map(async (id) => [id, await isAssignmentInSuperGraderScope(id)] as const),
  );
  return new Map(results);
}
