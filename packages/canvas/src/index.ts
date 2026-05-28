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
  email?: string | null;
  primary_email?: string;
  login_id?: string | null;
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
  course_section_id: number;
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

const MAX_429_RETRIES = 3;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

async function canvasFetch(
  config: CanvasConfig,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `https://${config.host}/api/v1${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };

  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(url, { ...init, headers });
    if (res.status !== 429) return res;
    lastRes = res;
    const retryAfter = Number(res.headers.get("Retry-After"));
    const seconds = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : DEFAULT_RETRY_AFTER_SECONDS;
    // Drain body so the connection can be reused
    await res.text().catch(() => "");
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
  return lastRes!;
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
 * True if `now` falls within the term's start/end window. A course with no
 * term, no start_at, or no end_at is treated as active (can't filter without
 * data). Listing terms via /accounts/:id/terms would be more authoritative
 * but requires account-admin scope, which most teachers don't have.
 */
export function isTermActive(
  term: CanvasTerm | undefined,
  now: Date = new Date(),
): boolean {
  if (!term) return true;
  if (term.start_at) {
    const start = new Date(term.start_at);
    if (!isNaN(start.getTime()) && now < start) return false;
  }
  if (term.end_at) {
    const end = new Date(term.end_at);
    if (!isNaN(end.getTime()) && now > end) return false;
  }
  return true;
}

/**
 * Fetch the authenticated user's currently-active courses: `available`
 * workflow_state AND term currently in progress. Excludes past-term
 * courses that Canvas hasn't auto-concluded, plus future-term draft
 * courses. Harkness is about today's classes; historical sync would
 * balloon API usage and trip Canvas's rate limiter.
 */
export async function listActiveTeachingCourses(
  config: CanvasConfig,
): Promise<CanvasCourse[]> {
  const path =
    "/courses?enrollment_type=teacher&per_page=100" +
    "&include[]=term" +
    "&state[]=available";
  const all = await paginate<CanvasCourse>(config, path);
  return all.filter((c) => isTermActive(c.term));
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
 * Each row carries `course_section_id` so we can group students by section.
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

/**
 * Students in a course as user records (one row per user, deduped by
 * Canvas — no section-fanout). Hits `/courses/:id/users` which exposes
 * `email` to teacher-scope tokens that the `/enrollments` embedded-user
 * field withholds. Used as the email source-of-truth in roster sync
 * alongside /enrollments (which carries section_id for the per-student
 * section accumulator). Discovered in OE 2026-05-20: /enrollments
 * returned user.email=null for 21/22 students, the old code fell back
 * to login_id, and Google-OAuth sign-in never matched the stored
 * "jsmith23"-style identifiers.
 */
export async function listCourseStudentUsers(
  config: CanvasConfig,
  canvasCourseId: string | number,
): Promise<CanvasUser[]> {
  const path =
    `/courses/${canvasCourseId}/users?` +
    "enrollment_type[]=student&enrollment_state[]=active&include[]=email&per_page=100";
  return paginate<CanvasUser>(config, path);
}

export type CanvasSection = {
  id: number;
  name: string;
  course_id: number;
  sis_section_id?: string | null;
};

/**
 * All sections of a course. Used to give the section ids returned by
 * enrollments a human-readable name for the section picker.
 */
export async function listCourseSections(
  config: CanvasConfig,
  canvasCourseId: string | number,
): Promise<CanvasSection[]> {
  const path = `/courses/${canvasCourseId}/sections?per_page=100`;
  return paginate<CanvasSection>(config, path);
}

/**
 * M7.5 — post a teacher-authored DRAFT comment on a single student's
 * submission. Draft visibility means the comment lands in SpeedGrader's
 * editable-drafts pane (visible to the teacher; hidden from the student
 * until the teacher posts it).
 *
 * Authored by the discussion's own teacher, using their per-teacher
 * Canvas token from `teachers.canvas_token_encrypted`. No `as_user_id`
 * masquerade — HH doesn't post as the student.
 *
 * Canvas API contract (verified against `instructure/canvas-lms`'s
 * `submissions_api_controller.rb#update`):
 *   PUT /api/v1/courses/:cid/assignments/:aid/submissions/:uid
 *     submission[draft_comment]=true
 *     comment[text_comment]=<plain text>
 *
 * `text_comment` is plain text; caller pre-flattens any HTML/markdown.
 * Comments aren't gated on submission_types (the controller calls
 * `find_or_create_submission(@user)`), so this works on every
 * assignment shape — including unsubmitted ones.
 */
export async function postTeacherDraftComment(
  config: CanvasConfig,
  canvasCourseId: string | number,
  canvasAssignmentId: string | number,
  canvasUserId: string | number,
  textComment: string,
): Promise<void> {
  const params = new URLSearchParams();
  params.set("submission[draft_comment]", "true");
  params.set("comment[text_comment]", textComment);

  const path = `/courses/${canvasCourseId}/assignments/${canvasAssignmentId}/submissions/${encodeURIComponent(String(canvasUserId))}`;

  const res = await canvasFetch(config, path, {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CanvasError(
      `Canvas PUT draft comment (assignment ${canvasAssignmentId} user ${canvasUserId}) returned ${res.status}.`,
      res.status,
      body,
    );
  }
  // Drain the body so the connection can be reused.
  await res.text().catch(() => "");
}
