// Canvas REST API client — Harkness Helper edition.
//
// Trimmed to Phase B's needs: token verification, course list, assignment
// list per course, student roster per course. No grade posting (Harkness's
// grading flow lives in super-grader). Mirrors super-grader's
// packages/canvas shape for eventual M5 consolidation.

export type CanvasConfig = {
  host: string;
  token: string;
};

export type CanvasUser = {
  id: number;
  name: string;
  short_name?: string;
  sortable_name?: string;
  primary_email?: string;
  login_id?: string;
};

export type CanvasTerm = {
  id: number;
  name: string;
  start_at?: string | null;
  end_at?: string | null;
};

export type CanvasCourse = {
  id: number;
  name: string;
  course_code?: string;
  workflow_state: string;
  start_at?: string | null;
  end_at?: string | null;
  term?: CanvasTerm;
};

export type CanvasAssignment = {
  id: number;
  course_id: number;
  name: string;
  description?: string | null;
  due_at?: string | null;
  points_possible?: number | null;
  workflow_state: string;
  published?: boolean;
};

export type CanvasEnrollmentUser = {
  id: number;
  name: string;
  sortable_name?: string;
  short_name?: string;
  email?: string | null;
  login_id?: string | null;
};

export type CanvasEnrollment = {
  id: number;
  user_id: number;
  course_id: number;
  enrollment_state: string;
  type: string;
  user?: CanvasEnrollmentUser;
};

export class CanvasError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

// =========================================================================
// Host + low-level fetch
// =========================================================================

export function normalizeHost(input: string): string {
  let h = input.trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "");
  h = h.replace(/\/.*$/, "");
  if (!h) throw new CanvasError("Canvas host is empty.", 0);
  if (!/^[a-z0-9.-]+$/.test(h)) {
    throw new CanvasError(`Canvas host has invalid characters: ${input}`, 0);
  }
  return h;
}

async function canvasFetch(
  config: CanvasConfig,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `https://${config.host}/api/v1${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

// Canvas paginates via Link header: `<https://...?page=2>; rel="next", <...>; rel="last"`.
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function paginate<T>(
  config: CanvasConfig,
  initialPath: string,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = initialPath;
  while (url) {
    const res = await canvasFetch(config, url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CanvasError(
        `Canvas ${url} returned ${res.status}.`,
        res.status,
        body,
      );
    }
    const page = (await res.json()) as T[];
    out.push(...page);
    url = parseNextLink(res.headers.get("Link"));
  }
  return out;
}

// =========================================================================
// Endpoints
// =========================================================================

export async function getSelf(config: CanvasConfig): Promise<CanvasUser> {
  const res = await canvasFetch(config, "/users/self");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new CanvasError(
        "Canvas rejected the token (401). Check that you copied the full token.",
        401,
        body,
      );
    }
    throw new CanvasError(
      `Canvas /users/self returned ${res.status}.`,
      res.status,
      body,
    );
  }
  return (await res.json()) as CanvasUser;
}

/**
 * Fetch all courses the authenticated user teaches, with term context.
 * Includes available + completed + unpublished so we can show full history;
 * the caller filters by workflow_state for the UI.
 */
export async function listTeachingCourses(
  config: CanvasConfig,
): Promise<CanvasCourse[]> {
  const path =
    "/courses?enrollment_type=teacher&per_page=100" +
    "&include[]=term" +
    "&state[]=available&state[]=completed&state[]=unpublished";
  return paginate<CanvasCourse>(config, path);
}

/**
 * Published + unpublished assignments for a course. Caller filters by
 * workflow_state if it only wants published.
 */
export async function listCourseAssignments(
  config: CanvasConfig,
  canvasCourseId: string | number,
): Promise<CanvasAssignment[]> {
  const path = `/courses/${canvasCourseId}/assignments?per_page=100`;
  return paginate<CanvasAssignment>(config, path);
}

/**
 * Active student enrollments for a course, with embedded user records.
 * One row per (user, section); a user enrolled in two sections appears twice.
 * Caller deduplicates by user.id when shaping the roster jsonb.
 */
export async function listCourseStudentEnrollments(
  config: CanvasConfig,
  canvasCourseId: string | number,
): Promise<CanvasEnrollment[]> {
  const path =
    `/courses/${canvasCourseId}/enrollments?` +
    "type[]=StudentEnrollment&state[]=active&include[]=user&per_page=100";
  return paginate<CanvasEnrollment>(config, path);
}
