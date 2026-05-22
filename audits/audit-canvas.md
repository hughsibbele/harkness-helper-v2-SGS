# HH Canvas-integration audit — roster sync / TargetPicker / Canvas writes

Date: 2026-05-22
Auditor: Claude Opus 4.7 (M6.22 theme #3)
Scope: Harkness Helper (`harkness-helper-v2-SGS`) — Canvas-touching paths only.
Sibling audits cover anonymizer math, state machine, PII scrub, auth/RLS,
super-grader webhook envelope; this audit deliberately stays in its lane.

Suite-wide themes checked against: (1) snapshot semantics, (2) state fences
on UPDATE, (3) transactional boundaries, (4) fail-open vs fail-closed,
(5) retry/idempotency. Plus HH-specific concerns: roster-sync fix
completeness, TargetPicker integrity, Canvas write surface today, marker
shape coherence.

File:line refs are absolute under `apps/web/src/`, `packages/canvas/src/`, or
`supabase/migrations/`. Read every cited line before quoting.

---

## 1. CRITICAL — TargetPicker silently clobbers manual participant de-selections every 5s while transcribing

**Severity:** Critical (data integrity — wrong participants land in the
discussion, anonymizer-scrubber gets the wrong roster slice)

**File:** `apps/web/src/app/dashboard/TargetPicker.tsx:88-98` (effect) +
`apps/web/src/app/dashboard/DiscussionList.tsx:71-75` (5s polling) +
`apps/web/src/app/dashboard/page.tsx:51-89` (server-side roster fetch +
fresh-object reference on every render)

**Scenario:**

`TargetPicker`'s "default participants to all-in-section" effect lives at
TargetPicker.tsx:88-98:

```typescript
useEffect(() => {
  if (!courseId) {
    setParticipantIds(new Set());
    return;
  }
  const students = rostersByCourseId[courseId]?.students ?? [];
  const pool = sectionId
    ? students.filter((s) => s.section_ids.includes(sectionId))
    : students;
  setParticipantIds(new Set(pool.map((s) => s.canvas_user_id)));
}, [courseId, sectionId, rostersByCourseId]);
```

The eslint suppression comment at TargetPicker.tsx:74 acknowledges
`rostersByCourseId` is in the dep array deliberately. But the parent
(`RecordingFlow` → `page.tsx`) is a server component that rebuilds the
`rostersByCourseId` object literally every time it renders:

```typescript
// page.tsx:77-89
const rostersByCourseId: Record<string, CourseRoster> = {};
for (const row of rostersRes.data ?? []) {
  ...
  rostersByCourseId[row.canvas_course_id] = { students: ..., sections: ... };
}
```

And the dashboard polls `router.refresh()` every 5s while ANY discussion is
in `uploaded` or `transcribing` (DiscussionList.tsx:71-75):

```typescript
useEffect(() => {
  if (!hasPending) return;
  const id = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
  return () => clearInterval(id);
}, [hasPending, router]);
```

Sequence of events:
1. Teacher uploads recording A, transcription starts → polling kicks on.
2. Teacher starts setting up recording B (different course, different
   section). Picks course, section, then **manually unchecks 2 students who
   were absent**.
3. 5 seconds later, polling fires `router.refresh()` → server re-renders
   page → `rostersByCourseId` is a NEW object reference (even though the
   underlying data is identical) → `TargetPicker` effect sees a "changed"
   dep → re-runs the default-all-in-section initializer → the 2 manual
   unchecks evaporate.
4. Teacher hits Upload → all 14 students get participation rows. The 2
   absent students get a participation they shouldn't have.

Downstream consequence: the absent students each get a `students` row
upserted with their real email, real anon_token, AND a `participations`
row linking them to a discussion where they were silently re-added. When
super-grader joins by `canvas_user_id` to find Harkness participation
indicators (`/api/super-grader/result`), those students show as having
participated in a discussion they were absent from.

The dep array comment hand-waves "depend only on the stable parent prop +
courseId" but `rostersByCourseId` is NOT stable — `page.tsx` constructs a
fresh literal every render and `RecordingFlow` passes it through
untouched (`RecordingFlow.tsx:134`). No `useMemo`, no caching at the
parent level. Only the `Recorder` and `TargetPicker` get keyed remounts on
`resetCounter` after a successful upload (RecordingFlow.tsx:124,131), not
on `router.refresh()`-driven re-renders.

**Fix direction:** Either (a) snapshot the picker's initial roster on
courseId/sectionId change ONLY (drop `rostersByCourseId` from the dep
array, capture once via a ref), or (b) introduce an "I touched this"
local flag — once the user clicks Select all / Deselect all / toggle a
checkbox, the auto-init no longer fires until course or section changes,
or (c) memoize `rostersByCourseId` upstream so its reference is stable
across refreshes when the data is unchanged. (c) is brittle (needs a
stable hash of the data) — (b) is the suite-pattern-matching choice.

This is a textbook "no snapshot semantics" defect (theme #1) layered on
top of "fail-open" (theme #4) — the picker assumes its own state is the
source of truth, but the parent prop overrides on every render.

---

## 2. HIGH — Sync silently writes an empty roster when Canvas hides email for every student in a course

**Severity:** High (silent zero-roster), depends on Canvas-instance config

**File:** `apps/web/src/lib/actions/canvas-sync.ts:90-194`

**Scenario:**

The 2026-05-20 fix is correctly applied — HH uses
`listCourseStudentUsers` which hits
`/courses/:id/users?enrollment_type[]=student&enrollment_state[]=active&include[]=email&per_page=100`
(packages/canvas/src/index.ts:265-273). The bracketed-array form is
correct. Pagination is wired through `paginate<T>` so >100 students don't
truncate. ✓

But: the email-shape guard at canvas-sync.ts:161:

```typescript
if (!rawEmail || !rawEmail.includes("@")) {
  continue;
}
```

silently drops the student WITHOUT counting how many rows were skipped,
WITHOUT surfacing the count to the teacher in `CanvasSyncResult`. If
Canvas's permission gate hides `email` for every student in a course
(the exact failure mode the 2026-05-20 fix was designed to defend
against — `email` is gated by a teacher permission Canvas withholds by
default), HH writes an empty `students: []` to course_rosters for that
course with `ok=true` and `students=N` reflecting only the rows where
email DID populate (zero, in this scenario).

The teacher sees in the footer: "Canvas cache: 5 courses · 80 assignments
· last synced 2 minutes ago" (page.tsx:167-169) — looks healthy. Open the
picker for that course → "No roster cached for this course. Refresh
Canvas if you just added students." (TargetPicker.tsx:268). Teacher
clicks sync again → same result. No diagnostic exists to say "Canvas
returned 14 students but all of them had no email field — your Canvas
token may need the SIS-import scope or your school may have email
visibility locked down."

Byte-level example: Canvas returns `[{id: 1234, name: "Jane Smith",
email: null, login_id: "jsmith23"}, ...]`. canvas-sync.ts:154-160 builds
`rawEmail = (null ?? null ?? "").trim().toLowerCase() = ""`. Guard at 161
hits, `continue` skips. Student never lands in `studentsById`. After
loop, `students = Array.from(studentsById.values()) = []`. Roster row
written with `students: []`. Anonymizer can't scrub a name from a
discussion involving Jane Smith — `course_rosters` reports she doesn't
exist.

**Fix direction:** Two-line change — accumulate `skipped: number` next to
`assignmentCount` and `studentCount`, surface in `CanvasSyncResult` so
the dashboard's "Sync now" button can render "5 courses synced. 14
students had no email and were skipped — check Canvas token scopes."
Suite-wide fix that should land in HH plus the sibling apps' sync flows.

---

## 3. HIGH — Sync has no transactional boundary; mid-flight Canvas failure leaves partial state

**Severity:** High (theme #3)

**File:** `apps/web/src/lib/actions/canvas-sync.ts:34-229`

**Scenario:**

`syncCanvasCache` iterates courses sequentially (canvas-sync.ts:90):

```typescript
for (const c of courses) {
  const [assignments, enrollments, users, sections] = await Promise.all([
    listCourseAssignments(config, c.id),
    listCourseStudentEnrollments(config, c.id),
    listCourseStudentUsers(config, c.id),
    listCourseSections(config, c.id),
  ]);
  ...
  // upsert canvas_assignment_cache
  // upsert course_rosters
}
```

Each iteration upserts directly (no transaction). If course #3's
`listCourseStudentUsers` returns Canvas 500 (or exhausts the 3×429
budget at packages/canvas/src/index.ts:96-127 and returns the final 429
response without retrying further), the `paginate` helper throws a
`CanvasError`, which propagates through `Promise.all`, which bubbles up
to the outer try/catch at canvas-sync.ts:217. Result returned to
caller: `{ok: false, message: "Canvas API error (500): ..."}`.

But courses #1 and #2 already had their assignments AND rosters upserted.
`teachers.last_canvas_sync_at` is NOT updated (the final UPDATE at line
197 is past the throw point). So the next sync runs against partially-
fresh, partially-stale state with no record of which courses had
completed. The dashboard footer shows the prior sync time. The teacher
clicks Sync again → it retries all 5 courses from scratch → wastes the
Canvas budget that did succeed.

Also: the inner upsert errors at lines 71, 116, 188 `return
{ok: false, message: ...}` mid-loop, abandoning the remaining courses
WITHOUT writing the courses that already succeeded into a "synced this
session" set. So the failure point is recoverable on retry (upserts are
idempotent), but the user-visible failure mode is "we synced 2 of your 5
courses and then stopped" — which IS NOT what the result object says.

**Fix direction:** Either (a) wrap the whole sync in a Postgres
transaction via `pg-tx`-style helper (overkill — sync is read-heavy),
or (b) make the result object carry `coursesAttempted`,
`coursesCompleted`, `coursesFailed: [{course_id, error}]` so the teacher
sees "synced 3/5; refresh to retry the 2 that hit Canvas timeouts."

Same shape as the suite-wide "no transactional boundary" theme.

---

## 4. HIGH — Canvas cache grows monotonically; deleted courses + assignments linger forever

**Severity:** High (stale picker offers deleted assignments; can lead to
participations bound to assignments that no longer exist in Canvas)

**File:** `apps/web/src/lib/actions/canvas-sync.ts` (no DELETE
anywhere — verified by `grep -n "delete\|DELETE" canvas-sync.ts` → zero
matches in business logic)

**Scenario:**

`syncCanvasCache` upserts into `canvas_course_cache` (line 55) and
`canvas_assignment_cache` (line 101) but never DELETEs rows that are no
longer returned by Canvas. The same is true of `course_rosters.students`
— it overwrites the WHOLE jsonb array, so dropped students vanish on the
next sync (good), but at the table level, no `course_rosters` row is
ever deleted when a course is removed from Canvas.

Consequences:
- A course de-published in Canvas in October still shows up as a chip in
  the TargetPicker until the cache row is manually deleted.
- An assignment deleted in Canvas (rare but possible) still appears in
  the assignment combobox. Teacher selects it, fills in participants,
  uploads — Canvas-side the assignment is gone, but HH happily creates a
  `discussions` row binding `canvas_assignment_id=N` to a non-existent
  assignment. The transcribe pipeline runs (it doesn't talk to Canvas);
  the super-grader push runs (envelope-only, no Canvas roundtrip); the
  result endpoint stays queryable. But the assignment label in the
  dashboard falls back to the raw numeric ID
  (DiscussionList.tsx:154-156) and nothing surfaces "this assignment is
  gone from Canvas."

No FK between `discussions.canvas_assignment_id` and
`canvas_assignment_cache.canvas_assignment_id` — verified by
`grep -rn "references.*canvas_assignment_cache" supabase` → zero
matches. Both are text columns matched by value only.

**Fix direction:** During sync, build the set of currently-returned
course/assignment IDs and `DELETE` the rows for the current teacher that
are NOT in that set. Same logic for course_rosters at course-removal
time. The `students` jsonb is already overwrite-style — only the table
keys leak.

Bonus follow-up: extending the dashboard to badge "Assignment removed
in Canvas" on discussions whose assignment ID no longer appears in
`canvas_assignment_cache` would catch the rare case where someone
deletes an active assignment.

---

## 5. HIGH — `finalizeDiscussion` silently drops participants who fall out of the roster between picker-time and upload-time

**Severity:** High (loss of data, no audit trail; downstream scrubber
mis-anonymizes)

**File:** `apps/web/src/lib/actions/upload-discussion.ts:66-119`

**Scenario:**

The picker passes `participantIds: string[]` to
`finalizeDiscussion` (RecordingFlow.tsx:101). On the server,
upload-discussion.ts:66-79 loads the current `course_rosters.students`
jsonb (NOT the snapshot the picker was rendered against — the very
latest state). It builds `rosterById` from that. Then at lines 106-119:

```typescript
const studentRows = participantIds
  .map((cuid) => {
    const r = rosterById.get(cuid);
    if (!r || !r.email) return null;
    return { ... };
  })
  .filter((r): r is NonNullable<typeof r> => r !== null);
```

If a participant was visible in the picker (because they were in the
last roster snapshot the server rendered) but has been dropped from
`course_rosters` between picker-render-time and submit-time (race
window: a parallel Canvas sync that ran between the two), the
`map → null → filter` silently drops them. No warning to the teacher,
no log line — the discussion is created with `participantIds.length`
LESS THAN the user expected, and the teacher gets no signal.

Worse: the discussion + participations rows are inserted INSIDE
`finalizeDiscussion`'s top-level code, NOT inside a transaction.
upload-discussion.ts:82-148 does:

1. Insert `discussions` row (line 82).
2. If success, build studentRows from filtered participants (line 106).
3. Upsert `students` rows.
4. Insert `participations` rows.

Each step can fail independently. If step 3 fails (e.g., students upsert
hits a constraint), step 4 doesn't run, but step 1 succeeded — leaving a
`discussions` row with state='uploaded' and ZERO participations. The
Inngest event still fires (line 152), transcribe runs, summary is
written, super-grader is notified — but the join in
`/api/super-grader/result` (route.ts:10 → `participations →
students.canvas_user_id`) returns nothing for that discussion, so SG
can't deliver this discussion's transcript to any student. From the
teacher's POV: "I see my recording transcribed in the HH dashboard, but
no super-grader card shows up in any student's super-grader view."

Combined with finding #1 (picker clobbers de-selections every 5s), the
roster-vs-picker drift surface is wider than it looks.

**Fix direction:** Two changes:
- (a) Return `{ok: true, droppedParticipants: cuid[]}` so the UI can
  toast "2 participants were dropped because they're no longer in your
  Canvas roster — sync and try again."
- (b) Wrap the discussion + students + participations writes in a
  SECURITY DEFINER stored procedure that does the three INSERTs as one
  transaction, returning a single row count. Today's per-statement
  failure mode allows orphaned discussion rows.

---

## 6. MEDIUM — Cross-teacher uniqueness on `discussions.canvas_assignment_id` blocks legitimate parallel teachers

**Severity:** Medium (single-tenant today, but the schema permits multi-
teacher and the constraint contradicts that)

**File:** `supabase/migrations/20260513120000_initial_schema.sql:76` +
`supabase/migrations/20260516140000_discussion_per_section.sql:14-21` +
`apps/web/src/lib/actions/prepare-discussion-upload.ts:42-57`

**Scenario:**

The composite unique constraint added in the per_section migration:

```sql
unique nulls not distinct (canvas_assignment_id, canvas_section_id);
```

is at the table level — not scoped by `teacher_id`. If teacher A and
teacher B both teach the same course (co-teach scenario) and both want
to record a Harkness discussion on the same Canvas assignment for the
same section, the second teacher's upload throws a DB unique-violation.
The dedupe pre-check in `prepare-discussion-upload.ts:42-49`:

```typescript
let duplicateQuery = admin
  .from("discussions")
  .select("id")
  .eq("canvas_assignment_id", canvasAssignmentId);
duplicateQuery = canvasSectionId
  ? duplicateQuery.eq("canvas_section_id", canvasSectionId)
  : duplicateQuery.is("canvas_section_id", null);
```

also is NOT scoped by `teacher_id` — so teacher B sees the message
"A recording is already linked to this assignment + section. Delete the
existing discussion first to re-upload." even though it's TEACHER A's
discussion, which they can't see or delete.

Today HH is single-tenant (one shared CANVAS_API_TOKEN; the setup
page acknowledges this at dashboard/setup/page.tsx:31-34) so the
realistic blast radius is "if two EHS teachers both use HH and both
record on the same Canvas assignment id, the second one is locked out."
Single-token tenancy means they're effectively the same Canvas user from
Canvas's POV, so this hurts collaboration patterns the data model
already names but the unique constraint forbids.

**Fix direction:** Either (a) add `teacher_id` to the composite unique
key: `unique nulls not distinct (teacher_id, canvas_assignment_id,
canvas_section_id)` (migration), AND scope the dedupe SELECT by
`teacher_id` (prepare action). Both changes need to ship together. Or
(b) leave today's behavior and document "HH discussions are
per-assignment globally; co-teachers should coordinate." (a) is better.

---

## 7. MEDIUM — Sync return doesn't distinguish "synced and got zero students" from "synced N students"

**Severity:** Medium (overlaps with #2; called out separately because
this is the UX surface, #2 is the upstream silent-drop)

**File:** `apps/web/src/lib/actions/canvas-sync.ts:210-216` +
`apps/web/src/lib/actions/canvas-sync.types.ts`

**Scenario:**

`CanvasSyncResult` returns `{ok: true, courses, assignments, students, syncedAt}`
on success. `students: 0` is a possible value (every course had no
email-shaped roster entries, see finding #2). The sync button UI
(`CanvasSyncButton.tsx`, not exhaustively read) renders "synced N
courses" with no callout when `students: 0` happens despite
`courses > 0`.

A teacher whose Canvas token doesn't expose email gets "Synced 5
courses." every time, no diagnostic, no roster. The footer's last-
synced timestamp keeps refreshing → all signals say "working."

**Fix direction:** Either add a non-fatal `warning` field to
`CanvasSyncResult` when `students === 0 && courses > 0`, OR (better) the
fix from finding #2 — surface `skipped` count separately. Same fix
covers both.

---

## 8. MEDIUM — Canvas 429 retry budget exhaustion returns the last 429 response as success-shaped

**Severity:** Medium (rare in practice — Canvas's per-token rate limit
isn't usually 4-in-a-row tight)

**File:** `packages/canvas/src/index.ts:96-127`

**Scenario:**

```typescript
const MAX_429_RETRIES = 3;
async function canvasFetch(...) {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(url, { ...init, headers });
    if (res.status !== 429) return res;
    lastRes = res;
    ...
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
  return lastRes!;
}
```

If all 4 attempts (initial + 3 retries) return 429, the function returns
the last 429 response. The caller (`paginate` at index.ts:142-155, or
`getSelf` at index.ts:166-184) then sees `res.status === 429`, hits
`!res.ok`, throws `CanvasError(..., 429)`. That throw propagates to
`syncCanvasCache`'s outer catch at canvas-sync.ts:217, which returns
`{ok: false, message: "Canvas API error (429): Canvas /... returned
429."}`.

This is **fine** at the outer surface — the operator sees a clean 429
error. But the per-course iteration in canvas-sync.ts:90-195 means if
courses #1-#3 succeed and course #4 exhausts the 429 budget, courses
#1-#3 are already persisted; the action returns failure. There's no
distinction in the result between "Canvas was down" and "Canvas rate-
limited us partway through" — same shape as finding #3 but specifically
for the 429-budget-exhaustion path. Suggest: the 429 case is
recoverable on retry (after the rate-limit window resets) but the user
has no way to know "wait 30 seconds and re-click sync" vs "Canvas is
broken; don't bother."

**Fix direction:** Categorize 429 vs 5xx vs 401 vs 403 in `CanvasError`
(`.kind: "rate-limit" | "auth" | "server" | "client"`) and have the
sync result surface a user-actionable hint. Same shape as HAH audit
finding #9.

---

## 9. MEDIUM — Roster overwrite drops per-student manual fixups

**Severity:** Medium (today no manual fixup UI exists; this is forward-
looking — but the data model already permits the corruption)

**File:** `apps/web/src/lib/actions/canvas-sync.ts:178-187`

**Scenario:**

`course_rosters` is upserted with the entire `students` jsonb replaced
on every sync:

```typescript
const { error: rosterError } = await admin.from("course_rosters").upsert(
  {
    teacher_id: teacher.id,
    canvas_course_id: String(c.id),
    students,
    sections: sectionsJson,
    last_synced_at: syncedAt,
  },
  { onConflict: "teacher_id,canvas_course_id" },
);
```

If a future feature lets admins manually patch a student's email
(e.g., "this student goes by `jdoe@episcopalhighschool.org` even though
Canvas SIS has `john.doe@...`") to fix anonymizer-token alignment
across the suite, the next sync silently overwrites it. The
`students` row in the `students` TABLE (separate from
`course_rosters.students` jsonb) is upserted on
`(teacher_id, canvas_user_id, canvas_course_id)` — but
`upload-discussion.ts:114` always uses the EMAIL FROM
`course_rosters.students` (via `rosterById`, line 79) when computing
`anonToken`. So the manual fix would have to live in `course_rosters`
to take effect, and `course_rosters` is fully overwritten.

Not a bug today; flag for the M6.24 ecosystem-consistency milestone if
anyone proposes a "patch student email" admin UI.

**Fix direction:** When such a feature lands: separate "Canvas-sourced
email" from "manually-overridden email" — store the override on the
`students` row, use it preferentially in `finalizeDiscussion`. Mark
this in the BUILD_PLAN as a constraint on any roster-edit affordance.

---

## 10. LOW — Single-tenant Canvas token has no validity heartbeat

**Severity:** Low (mitigated by the "Test Canvas" button at
dashboard/setup/page.tsx:52)

**File:** `apps/web/src/lib/actions/canvas-test.ts` +
`apps/web/src/lib/actions/canvas-sync.ts:34-49`

**Scenario:**

`CANVAS_API_TOKEN` is a single env var on Vercel. When it's rotated
(or accidentally revoked in the Canvas admin), the next sync attempt
returns `{ok: false, message: "Canvas API error (401): ..."}` from
canvas-sync.ts:218-222. No proactive heartbeat — nothing tells the
teacher "your token expired" until they hit Sync. The `TestCanvasButton`
on setup page is one-click verifiable, so this is workable, but a
nightly cron-triggered heartbeat that writes
`teachers.canvas_token_last_verified_at` would let the dashboard surface
a red badge if the token has been bad for >24h.

**Fix direction:** Skip unless the school's rotation cadence makes this
worth automating. Low value.

---

## 11. LOW — `canvas-sync` doesn't paginate over courses

**Severity:** Low (most teachers teach <100 courses)

**File:** `packages/canvas/src/index.ts:215-224` (course list path) +
`apps/web/src/lib/actions/canvas-sync.ts:51`

**Scenario:**

`listActiveTeachingCourses` DOES paginate via the `paginate<T>` helper
(line 222). ✓ But the filter at line 223 (`.filter(c => isTermActive(c.term))`)
runs AFTER all pages are pulled. So pagination is fine — just noting
this branch was checked.

No actual finding here; remove or keep as a sanity note.

---

## 12. LOW — Marker file is reference-only with zero callers (intentional)

**Severity:** Informational

**File:** `apps/web/src/lib/peers/marker.ts`

`HARKNESS_TRANSCRIPT_MARKER = "<!-- harkness:transcript v=1 -->"` matches
the `<peer>:<artifact> v=<n>` integration-contract shape. `grep -rn
"HARKNESS_TRANSCRIPT_MARKER\|prependHarknessMarker" --include="*.ts" --include="*.tsx"`
returns ONLY the definition and self-referential matches in marker.ts —
no live callers, as the file comment correctly documents ("Forward-
compat only — HK does not currently post transcripts to Canvas
submission bodies.").

`prependHarknessMarker` is idempotent (early-return on
`body.startsWith(HARKNESS_TRANSCRIPT_MARKER)`) — correctly handles the
re-post case for when a future writer lands. ✓

No live Canvas write surface in HH today. Verified by
`grep -rn "as_user_id\|POST.*assignments\|PUT.*assignment\|submission_comments\|masquerade"`
under HH — zero matches outside type definitions. ✓

---

## Cross-cutting observations

**Roster-sync 2026-05-20 fix completeness: YES.** HH has exactly ONE
roster-fetching code path: `syncCanvasCache` in
`apps/web/src/lib/actions/canvas-sync.ts`. `grep -rn
"listCourseStudentEnrollments\|listCourseStudentUsers\|/enrollments\|/courses/.*users\|include\[\]=email\|primary_email"`
across the whole repo returns only `packages/canvas/src/index.ts` (the
client) and `apps/web/src/lib/actions/canvas-sync.ts` (the only caller).
No per-course re-sync route (cf. HAH finding #2 — HAH had two paths and
fixed only one). No admin re-sync endpoint. No diagnostic
`canvas-test.ts` does roster fetching — it only calls `getSelf`. The fix
is centralized; the bug HAH had can't happen here.

Caveat: the suite-wide guard ("reject non-email-shaped rows") is
present at canvas-sync.ts:161 but does NOT surface a skipped-count to
the operator — see finding #2 / #7.

**`include[]=email` bracket form is correct.** Verified at
`packages/canvas/src/index.ts:271`:

```typescript
"enrollment_type[]=student&enrollment_state[]=active&include[]=email&per_page=100"
```

Bracket form, not bare `include=email` — Canvas-silent-ignore failure
mode from the HAH history is closed here. ✓

**Pagination correctly threaded through every endpoint.** All four
roster-relevant endpoints (`listActiveTeachingCourses`,
`listCourseAssignments`, `listCourseStudentEnrollments`,
`listCourseStudentUsers`, `listCourseSections`) use the shared
`paginate<T>` helper at packages/canvas/src/index.ts:139-160, which
follows the Link header's `rel="next"` until exhausted. >100 students
in a single course will not truncate. ✓

**Section roster fetch uses safe path.** HH does NOT call
`/sections/:id/enrollments` (which would have the email-null gotcha).
Sections come from `/courses/:id/sections` (just `{id, name}` for the
section picker labels), and student-to-section mapping comes from
`/enrollments?include[]=user`'s `course_section_id` field, which is
NOT permission-gated. Verified by `grep -rn "/sections/"` → only the
non-enrollments call to `listCourseSections`. ✓

**No `as_user_id` masquerade anywhere.** HH's single-tenant token
reads as the holder. There are no Canvas writes today — the marker is
forward-compat with no caller. When a future writer lands, the install
path should write AS the teacher (no masquerade), and any per-student
submission-comment path will need masquerade if it lands. Today's
absence is correct.

**Active-term + state[]=available filter is in place.**
`listActiveTeachingCourses` at packages/canvas/src/index.ts:215-224 hits
`/courses?enrollment_type=teacher&state[]=available&include[]=term&per_page=100`
and then filters via `isTermActive(c.term)` for in-window currentness.
Past-term unconcluded courses + future-term draft courses are excluded.
✓ (CLAUDE.md's claim matches the code.)

**Canvas 429 handling is real.** `canvasFetch` at
`packages/canvas/src/index.ts:96-127` reads the `Retry-After` header,
falls back to 5 seconds, retries up to 3 times. Sequential per-course
iteration in `syncCanvasCache` (canvas-sync.ts:90, comment at line 79
"Sequential per-course to stay under Canvas's concurrency budget")
keeps concurrent requests to 4 per course (the inner `Promise.all`)
which is well under Canvas's typical 100-req/min token budget. ✓
Failure mode after exhaustion: finding #8.

---

## Suggested priority order for fixes

1. **Finding #1** (TargetPicker clobbers de-selections every 5s) — silent
   data-integrity regression. Teacher clicks "uncheck the 2 absent
   students", waits 5 seconds while another transcription is running,
   uploads — both unchecked students get participations. Affects every
   live recording day. Highest blast radius.
2. **Finding #5** (`finalizeDiscussion` silently drops out-of-roster
   participants) — second-order failure mode of #1, but also a real
   path on its own when sync races with upload.
3. **Finding #2** + **#7** (silent zero-roster on email-hidden Canvas
   configs) — single fix surfaces both. Adds operator signal.
4. **Finding #3** (no transactional boundary on sync) — partial-state
   bugs that would surface on Canvas instability days.
5. **Finding #4** (cache grows monotonically) — stale picker offerings
   become a UX papercut over a semester.
6. **Finding #6** (cross-teacher uniqueness blocks co-teach) — wait
   until co-teach is a real use case; preserve today's behavior with
   docs.
7. **Findings #8-11** — quality-of-life, low priority.

## Themes

HH's Canvas integration today is narrow (read-side only — no write
paths, no submission posts, no card install, no comments). The
suite-wide 2026-05-20 roster-email fix is correctly applied in the ONLY
roster-fetching code path; HH does not have HAH's "per-course re-sync
route was missed" defect. The bracket form on `include[]=email`,
`enrollment_state[]=active`, `per_page=100`, and proper Link-header
pagination are all present and correct.

The findings that DO exist concentrate on (1) UX-state-management
defects where the picker's local state gets overwritten by server-side
re-renders, (2) "silent skip" failures where guards correctly REJECT
bad data but never surface the rejection count, and (3) lack of
transactional boundaries between the multi-step writes that finalize a
discussion or sync a course. Themes #1 (no snapshot), #3 (no
transactional boundary), and #4 (fail-open via silence) dominate.

When M7.5 lands the Canvas card install for HH, the marker
(`peers/marker.ts`) is canonical and ready; the installer should reuse
the AID/HAH pattern (anchor-fallback finder, masquerade-as-teacher for
install, snapshot destination flags into install_state).
