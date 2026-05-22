# HH Audit — Auth / Authz / RLS / Storage / Admin / Token Encryption / Setup-Page Divergence

Date: 2026-05-22
Branch: main
Auditor: M6.22 theme #6 (auth + RLS + storage paths + at-rest tokens + setup divergence)
Scope: every layer that gates "who can read or change what" — proxy, OAuth callback, admin gate, RLS policies, storage path security, every `createAdminDbClient()` call site, super-grader bearer ingress, Google-token storage, last-admin-lockout, setup-page shape against AID.
Reference: `/Users/hkoeze/code/super-grader-suite/handwritten-assignment-helper-v2-SGS/audits/audit-auth-rls.md`

Severity legend:
- **CRITICAL** — exploitable privilege escalation / cross-teacher data exposure with low pre-conditions.
- **HIGH** — exploitable with modest pre-conditions, or persisted secrets exposed beyond their need-to-know set.
- **MEDIUM** — fail-open or hardening gap that could be combined with another bug.
- **LOW** — defense-in-depth gap, no current exploit path.
- **INFO** — observation worth recording.

---

## 1. HIGH — Plaintext Google OAuth refresh tokens at rest on `teachers.google_*`

**Files**
- `supabase/migrations/20260516150000_teacher_google_tokens.sql:13-16`
- `apps/web/src/app/auth/callback/route.ts:55-75` (capture into row)
- `apps/web/src/lib/google/auth.ts:39-46,84-94` (read + rewrite tokens)
- `apps/web/src/lib/auth/teacher.ts:24-28` (`select("*")` on the teacher row)

**Scenario**
`teachers.google_access_token` and `teachers.google_refresh_token` are stored verbatim — no AES-GCM envelope, no pgsodium wrapping, no `*_ENC_KEY` env var anywhere in HH. The Drive helper at `lib/google/auth.ts:67-73` reads the raw values back out and feeds them directly into `google.auth.OAuth2.setCredentials`. The auth callback at `route.ts:67-75` writes `providerToken` / `providerRefreshToken` straight from the Supabase session into the row.

Compare to AID, which encrypts its Canvas API token at rest (`teachers.canvas_token_encrypted`, AES-GCM via `packages/crypto`). HH's contract is asymmetric: HH stores no per-teacher Canvas token (single-tenant env-var design — `CANVAS_BASE_URL` + `CANVAS_API_TOKEN` only, verified at `lib/actions/canvas-test.ts:25-26` and `lib/actions/canvas-sync.ts:19-20`), but it DOES store per-teacher Google refresh tokens for Drive/Docs scopes. Those refresh tokens are long-lived (Google won't reissue them without `prompt=consent` per `auth/login/route.ts:36-37`), so once exfiltrated they grant durable Drive access to the holder's `drive.file` + `documents` scopes (= every file HH-Harkness ever created in the teacher's Drive).

**Who can read these tokens?**
- The owning teacher reads their own row via `getCurrentTeacher`'s `select("*")` (`lib/auth/teacher.ts:24-28`). RLS `teachers_self_select` (`migration 20260513120000:152-153`) restricts to `auth_user_id = auth.uid()`, so no cross-teacher leak via this path. The tokens land in the server-component render but are not propagated to client components anywhere I could find (`grep teacher={teacher}` returns no hits).
- Any admin reading via the `teachers_admin_select` policy (`migration 20260513120001:119-120`) gets full row access including the tokens. With `INITIAL_ADMIN_EMAIL` bootstrap, that's at least one human; with the grant-admin UI, potentially many. A curious admin can SELECT every teacher's `google_refresh_token` and impersonate any of them against Drive.
- The Supabase service-role key holder (anyone with the `SUPABASE_SERVICE_ROLE_KEY` env var on Vercel or anyone running `supabase` CLI against the linked project) reads everything regardless of RLS.

**Exploit path (admin → cross-teacher Drive impersonation)**
1. Admin signs in.
2. Admin opens devtools, runs `fetch("https://<supabase-rest>/rest/v1/teachers?select=email,google_refresh_token", { headers: { authorization: "Bearer <their JWT from supabase-auth-token cookie>", apikey: "<publishable key from page source>" } })`.
3. RLS policy `teachers_admin_select` permits the SELECT because `is_admin()` is true. The response includes every teacher's refresh_token in cleartext.
4. Admin pipes the refresh_token into a local `google-auth-library` client (any Node script, ~20 LOC), gets a fresh access_token, and reads any HH-created Drive file under `drive.file` scope plus any Doc the app has access to via `documents` scope.

There's no encryption-at-rest defense against the admin or the service-role; the exposure is by-design via RLS. The fix is to move tokens off the row that admins can SELECT.

**Fix direction**
- Move tokens into a separate table `teacher_google_tokens` whose SELECT policy is `auth_user_id = auth.uid()` only — drop the admin overlay. Admins lose nothing operational (they never play back as another teacher; the admin console doesn't render the row's tokens).
- OR: AES-GCM encrypt at rest with a key only the server process holds (`HH_TOKEN_ENC_KEY`). The admin SELECT then returns ciphertext. Mirror AID's `packages/crypto` shape.
- Drop `google_access_token` / `google_refresh_token` from `getCurrentTeacher`'s `select("*")` and add an explicit column list so the tokens never enter the server-component render for any teacher whose code path doesn't actually need them (defense-in-depth — most pages just need `email`, `display_name`, `id`).

---

## 2. HIGH — Bearer-token comparison uses `!==`, not constant-time compare

**File**
- `apps/web/src/lib/peers/auth.ts:21`
  ```ts
  if (!match || match[1] !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  ```

**Scenario**
The super-grader ingress endpoints (`/api/super-grader/result` at `api/super-grader/result/route.ts:5-7` and `/api/super-grader/prompt` at `api/super-grader/prompt/route.ts:27-29`) gate every request via `checkSuperGraderBearer`. The compare is a plain JS `!==` — V8 string equality short-circuits at the first mismatching character, leaking the per-byte match progress as observable latency.

What's behind the gate:
- `/api/super-grader/result` returns the full HarknessEnvelope: 1-hour signed audio URL for the discussion recording, full verbatim transcript, full feedback summary, anon token — all for any `(canvas_user_id, canvas_assignment_id)` pair the attacker queries. With the token in hand, an attacker can iterate every assignment ID (small integers) × every canvas_user_id and exfiltrate every transcribed discussion HH ever produced. FERPA-grade audio + text.
- `/api/super-grader/prompt` is less sensitive (returns prompt body — not student data) but still admin-curated content.

The token's blast radius pairs badly with the lack of rate-limiting on the endpoints; a sustained side-channel attack is feasible. The constant-time defense is the textbook fix.

**Comparison to environment**
HAH audit finding #4 is the same vuln (`src/lib/peers/auth.ts:21` there). The shared `peers/auth.ts` shape was copied across satellites; HH inherited the bug. AID likely has it too.

**Fix direction**
```ts
import { timingSafeEqual } from "node:crypto";
const a = Buffer.from(match[1] ?? "");
const b = Buffer.from(expected);
if (a.length !== b.length || !timingSafeEqual(a, b)) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```
Also confirm `HARKNESS_API_TOKEN` is ≥32 bytes of true entropy and that it rotates on the same cadence as the rest of the suite.

**Bearer-presence verdict (fail-closed):** correct. `auth.ts:12-18` returns a 500 when `HARKNESS_API_TOKEN` is unset, not a 401. That's good — a missing env var crashes loud, doesn't fall through to "no expected → accept any". Specifically, the `if (!expected) return 500` guard precedes the compare, so `expected` is always a non-empty string by the time `match[1] !== expected` runs. Fail-closed on missing config, byte-leak on present config; only the second one is a finding.

---

## 3. MEDIUM — Teachers can self-update `email`, `google_*` tokens, and other system-set columns via RLS

**File**
- `apps/web/src/../supabase/migrations/20260513120000_initial_schema.sql:154-155`
  ```sql
  create policy teachers_self_update on teachers
    for update using (auth_user_id = auth.uid());
  ```

**Scenario**
The `teachers_self_update` policy has no `WITH CHECK` and no column-level grant restriction. Postgres falls back to USING for WITH CHECK, so a teacher CAN'T change their `auth_user_id` to someone else's (the new row would fail the USING check). But they CAN UPDATE columns the app considers system-managed:

- `email` — overwriting this changes which Google identity matches the row on next sign-in (the callback upserts on `auth_user_id`, not email, so this doesn't immediately break sign-in, but it does poison admin overlays and audit logs).
- `google_access_token`, `google_refresh_token`, `google_token_expires_at` — a teacher could overwrite their own tokens with garbage (self-DoS the Drive integration), or copy them to/from elsewhere via a sequence of UPDATEs. Self-inflicted; no cross-teacher impact.
- `last_canvas_sync_at` — purely cosmetic, but teacher could lie about freshness.
- `display_name` — harmless.

**Exploit shape**
A teacher opens devtools, gets their Supabase JWT from cookies, and runs:
```js
fetch("https://<supabase-rest>/rest/v1/teachers?id=eq.<their-own-uuid>", {
  method: "PATCH",
  headers: {
    authorization: "Bearer <jwt>",
    apikey: "<publishable>",
    "content-type": "application/json",
    prefer: "return=minimal"
  },
  body: JSON.stringify({ email: "other.teacher@episcopalhighschool.org" })
})
```
The RLS check passes (`auth_user_id = auth.uid()` is still true), the row is updated, and the teacher now has a hostile email field on their own row. The next admin who opens `/admin/admins` and grants admin to `other.teacher@episcopalhighschool.org` instead grants to a row that doesn't match that user's actual Google identity, which silently breaks admin grant.

Low blast radius today because there's no cross-teacher elevation; this is a defense-in-depth gap.

**Fix direction**
Add `WITH CHECK (auth_user_id = auth.uid())` for tidiness AND drop the policy to per-column UPDATE grants:
```sql
revoke update on teachers from authenticated;
grant update (display_name) on teachers to authenticated;
```
(Only `display_name` is genuinely a teacher-owned setting today — every other column is system-set. The auth callback writes via service-role, the Drive auth helper writes via service-role, Canvas sync writes via service-role. Locking down to just `display_name` doesn't break any current flow.)

---

## 4. MEDIUM — `/admin/page.tsx` and `/admin/prompts/page.tsx` rely solely on the layout's admin gate

**Files**
- `apps/web/src/app/admin/layout.tsx:14-16` (the gate)
- `apps/web/src/app/admin/page.tsx:1-3` (no own gate)
- `apps/web/src/app/admin/prompts/page.tsx:36-43` (no own gate; queries via admin client)
- `apps/web/src/app/admin/admins/page.tsx:6-15` (calls `getCurrentAdminEmail()` itself — defense-in-depth ok)

**Scenario**
Next.js layouts run before child pages, so the layout's `await getCurrentAdminEmail(); if (!adminEmail) redirect("/dashboard")` IS the live gate today. But Next 16's `layout.tsx` is shared per segment; if a future refactor adds a new admin page that's parallel-rendered or that opts out of the layout chain (e.g., a route group or a `(no-layout)/` group), the gate evaporates. The reference HAH audit finding #17 verifies that HAH adds an explicit `isAdmin()` call inside each `/api/admin/*` route — HH has no `/api/admin/*` routes (verified by `find apps/web/src/app/api -type f` — only `inngest`, `super-grader/prompt`, `super-grader/result`), so layout-only protection is OK for the page surface, but:

- The admin server actions (`lib/actions/admins.ts` lines 9-10, 43-44, `lib/actions/system-prompts.ts:17-18`) each call `getCurrentAdminEmail()` at the top and bail with `{ ok: false, message: "Admin only" }` if not admin. Verified — each action is independently gated. Good.
- `/admin/page.tsx` itself is just a list of tiles — no data, no actions. Layout gate is sufficient.
- `/admin/prompts/page.tsx` loads prompts via service-role admin client and renders them. If layout gate ever evaporates, this leaks system prompt bodies to non-admin teachers. The prompts SELECT policy on `prompts` (migration 20260513120001:92-96) allows any authenticated user to SELECT system-scoped prompts anyway, so the leak is bounded — but the *admin client* used at line 37 bypasses RLS, so a layout-skip would expose `is_default=false` system prompts (none today, but the schema permits them).

**Fix direction**
Add a one-line `await isAdmin() || redirect("/dashboard")` at the top of `admin/prompts/page.tsx` and `admin/page.tsx` for defense-in-depth. Cost is one DB roundtrip already-memoized via `React.cache()` in `lib/auth/admin.ts:13`, so effectively free.

---

## 5. MEDIUM — Last-admin-lockout guard has a read-then-update race

**File**
- `apps/web/src/lib/actions/admins.ts:67-89`

**Scenario**
The guard does `SELECT count(*) WHERE active=true` (line 68-71), checks `count <= 1` (line 73), then `UPDATE admins SET active=false` (line 80-83). Two simultaneous revoke actions from two different active admins (say there are exactly 2 active admins, A and B, and both decide to revoke the other in the same tick) can race:
- Admin A reads count=2 → passes guard.
- Admin B reads count=2 → passes guard.
- Admin A's UPDATE goes through → B now revoked, count=1, but A revoked themselves too… actually A is revoking B.
- Admin B's UPDATE goes through → A now revoked, count=0.

Both admins are now inactive. The admin layer is locked out. Recovery requires `supabase` CLI / dashboard access to flip an `active` flag, OR redeploying with `INITIAL_ADMIN_EMAIL` set + manually wiping `admins` table.

The probability is low (requires near-simultaneous human action), but the recovery is painful. The fix is a single transactional check.

**Fix direction**
Wrap in a SECURITY DEFINER function that does `SELECT count(*) ... FOR UPDATE` within the same transaction as the UPDATE:
```sql
create or replace function revoke_admin_safely(p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  if not is_admin() then return 'not_admin'; end if;
  select count(*) into v_count from admins where active = true for update;
  if v_count <= 1 then return 'last_admin'; end if;
  update admins set active = false where email = p_email and active = true;
  return 'ok';
end;
$$;
```
Or simpler: add a partial unique constraint `create unique index admins_one_active on admins ((true)) where active = true;` — no, that's wrong (it'd allow only one active admin). The right shape is a CHECK + transactional guard.

Maps to root cause #2 (no state fence on UPDATE) + #3 (no transactional boundary).

---

## 6. MEDIUM — `INITIAL_ADMIN_EMAIL` bootstrap insert is not idempotent under concurrent fetch

**File**
- `apps/web/src/lib/auth/admin.ts:32-48`

**Scenario**
The bootstrap path:
```ts
const { count } = await admin.from("admins").select(..., { count: "exact", head: true });
if (count && count > 0) return null;
await admin.from("admins").insert({ email, granted_by_email: "system", active: true });
return email;
```
Two simultaneous first-visits with the SAME `INITIAL_ADMIN_EMAIL`:
- Tab A reads count=0 → passes guard.
- Tab B reads count=0 → passes guard.
- Tab A inserts → row exists.
- Tab B inserts → conflict on PK (`email text primary key`).

Postgres rejects Tab B's INSERT with a unique-constraint violation; the await throws (uncaught here — there's no try/catch on the INSERT). The page render that triggered Tab B 500s.

Cost is low (one re-load fixes it; the second tab will read count=1 and skip the insert path). But the user-facing failure mode is a generic 500 with no actionable message.

The function is also `React.cache()`-wrapped (line 13), so concurrent fetches *within the same render* dedupe — but two separate requests in two browser tabs each have their own cache.

Maps to root cause #5 (no idempotency on a write).

**Fix direction**
Use ON CONFLICT:
```ts
await admin.from("admins").upsert(
  { email, granted_by_email: "system", active: true },
  { onConflict: "email", ignoreDuplicates: true }
);
```
Then a concurrent INSERT becomes a no-op instead of a thrown 500.

---

## 7. MEDIUM — Setup page divergence from AID — Drive section is HH-only; no shared shape

**Files**
- `apps/web/src/app/dashboard/setup/page.tsx:1-127` (HH setup)
- `/Users/hkoeze/code/super-grader-suite/ai-documenter-v2-SGS/apps/teacher-admin/src/app/dashboard/setup/page.tsx:1-117` (AID setup, reference)

**Scenario**
The feedback memory at `/Users/hkoeze/.claude/projects/-Users-hkoeze-code-super-grader-suite/memory/feedback_app-setup-consistency.md` (paraphrased: AID/OE/HH/HAH should share the same setup UI shape) implies the four satellite apps should converge on a common setup-page skeleton: a Canvas connection panel (status badge + connect/test button + token-source explanation) and any other per-app connections.

HH's divergence points vs AID:

| AID setup-page element | HH equivalent | Drift |
|---|---|---|
| `<header>` with title + description (lines 22-32) | Lines 18-26 | Roughly matches shape; HH says "Verify the connections" vs AID's "We use your Canvas API token to read your courses…" — different framing |
| Inline green/amber status banner above the connect form (lines 34-65) | No equivalent — HH has a single inline dl table with `set / missing / Connected / Not connected` (lines 37-50, 86-99) | **Divergence: no top-of-page banner** |
| `<ConnectForm />` for token paste-in (line 85) | No equivalent — HH is single-tenant, no per-teacher Canvas token | **By design: HH uses shared env var** |
| `<CardTextEditor />` (lines 88-92) | No equivalent — HH has no card-text concept | **By design** |
| "What we use the token for" panel (lines 94-114) | No equivalent | **Divergence: no rationale block** |
| Test-connection button | TestCanvasButton (line 52) | **HH has this, AID does NOT** |
| Token rotation help (admin only) | Lines 54-74 (admin-gated copy block) | **HH has this, AID does NOT** |
| Drive connection panel | Lines 77-123 (Drive status + sign-out-to-reconnect button) | **HH has this, AID does NOT — HH needs per-teacher Drive scopes** |

So HH and AID are roughly the same shape (header + status panels) but the per-section copy and the included panels diverge significantly. The biggest divergence is **HH has a Drive section that AID doesn't; AID has a CardTextEditor that HH doesn't.** Those are by-design (different apps' integration scopes), so a strict "must match" reading of the memory would fail.

The pragmatic read: the *shape* should be consistent — status-badge-up-top + per-connection panel + admin-only rotation notes. HH's pattern (status table inside the panel, no top banner) doesn't match AID's pattern (banner above the form, then form). 

**Severity**
MEDIUM (UX inconsistency). No setup-critical functionality is hidden: the teacher CAN test the Canvas connection (`TestCanvasButton`), CAN see whether Drive is connected, CAN see how to reconnect Drive (sign out + back in), and the admin CAN see rotation instructions. The drift is cosmetic.

**Fix direction**
Two paths:
1. **Cosmetic harmonization (M7.2 style):** Lift the green/amber status banner pattern from AID into a shared `<ConnectionStatus>` component placed at the top of each connection panel — used twice on HH (Canvas + Drive), once on AID (Canvas), once on OE/HAH. Keep the by-design divergent inner content.
2. **Accept the drift as documented:** HH's setup page IS legitimately doing more (two connections vs one). Note this in CLAUDE-local docs and de-scope the harmonization.

The audits campaign should call this MEDIUM rather than HIGH because the apps run; the divergence is aesthetic.

---

## 8. LOW — `audio_url` storage path uses teacher_id + canvas_assignment_id; signed-upload TTL not configurable

**Files**
- `apps/web/src/lib/actions/prepare-discussion-upload.ts:59-65`
- `apps/web/src/lib/actions/upload-discussion.ts:40-42`

**Scenario**
The storage path is generated server-side: `${teacher.id}/${canvasAssignmentId}/${sectionSlug}/recording.${ext}` (`prepare-discussion-upload.ts:61`). Path is NOT client-supplied, which prevents a malicious teacher from PUTting into another teacher's prefix.

`finalizeDiscussion` then re-validates that the storagePath starts with `${teacher.id}/` (line 40-42) before writing the DB row, so even if the upload URL is leaked and used to write to an arbitrary path, the metadata row can only land under the calling teacher's id. Good.

What's worth flagging:
- The signed UPLOAD URL TTL isn't specified at `createSignedUploadUrl` (`prepare-discussion-upload.ts:64-65`) — Supabase defaults to 2 hours for signed upload URLs. For a typical 30-60 second upload, 2 hours is generous; if the URL leaks via referrer-leak or browser-history sharing, the attacker has 2 hours to overwrite any file under the teacher's audio prefix (because `upsert: true` is set on line 65).
- The signed PLAYBACK URLs are TTL'd:
  - Dashboard playback: 1 hour (`dashboard/page.tsx:16`).
  - SG-envelope audio_url: 1 hour (`peers/envelope.ts:5`).
  - Drive-save fetch (server-internal): 5 minutes (`save-to-drive.ts:118`).
  - Inngest transcription fetch (server-internal): 30 minutes (`transcribe-discussion.ts:24`).
- The signed-upload TTL is the most exposed (it's the only one the client can intercept in normal flow) — a 2-hour TTL on a write-capable URL is large.

**Fix direction**
- Drop the upload TTL to ≤ 5 minutes; the client uploads within seconds of being issued the URL.
- Add a `Content-Length` / mime-type binding to the signed URL if the Supabase storage SDK supports it (older versions don't; recent ones do via the `createSignedUploadUrl` options).

Storage path security is otherwise sound: paths include the teacher uuid + the assignment id + section slug, so even a successful path-traversal would land in the teacher's own prefix.

---

## 9. LOW — `participations` and `students` have only SELECT policies; INSERT/UPDATE/DELETE rely on missing-policy=deny

**Files**
- `supabase/migrations/20260513120000_initial_schema.sql:148-170`

**Scenario**
RLS is enabled on `students`, `discussions`, `participations`, but only SELECT policies exist. Postgres' RLS contract is "no policy = no permission," so authenticated users cannot INSERT/UPDATE/DELETE rows in these tables. Every write goes through the service-role client. Verified by enumerating `createAdminDbClient()` call sites — every write to students/discussions/participations is on the service-role path:
- `auth/callback/route.ts:64-89` (teacher upsert, service-role).
- `lib/actions/upload-discussion.ts:44,82,122,135` (finalize → discussion/students/participations, service-role).
- `lib/actions/delete-discussion.ts:14,32,40` (delete + storage cleanup, service-role).
- `lib/actions/canvas-sync.ts:47,55,178,197` (Canvas cache + roster + teacher last-synced, service-role).
- `lib/inngest/transcribe-discussion.ts:59,71` (state machine + transcript + summary writes, service-role).
- `lib/peers/notify.ts:55` (super-grader push status, service-role).
- `lib/google/auth.ts:39,85` (refresh-token rotation, service-role).

This is a defensible pattern but it depends on every server-side write being mediated by app code that *authenticates the caller* before invoking the service-role client. The audit confirms:
- `finalizeDiscussion` calls `getCurrentTeacher` then validates `storagePath.startsWith(${teacher.id}/)` (line 40-42). ✓
- `deleteDiscussion` calls `getCurrentTeacher` then checks `discussion.teacher_id !== teacher.id` (line 24-26). ✓
- `saveAudioToDrive` / `saveTranscriptToDrive` / `saveSummaryToDrive` / `saveAllToDrive` all call `getCurrentTeacher` then `loadDiscussionCtx` which does the same teacher-id check (`save-to-drive.ts:45`). ✓
- `syncCanvasCache` calls `getCurrentTeacher` then writes only rows keyed on `teacher.id`. ✓
- `prepareDiscussionUpload` calls `getCurrentTeacher` then encodes `teacher.id` in the storage path; the deduplication query at lines 42-49 is on `(canvas_assignment_id, canvas_section_id)` *without a teacher_id filter* — see following finding for the subtle issue.

**Severity** LOW (the pattern works; no exploit identified). The risk is that any FUTURE server action that uses `createAdminDbClient` without first calling `getCurrentTeacher` introduces a hole — there's no compile-time invariant enforcing the pairing. Documenting this in CLAUDE-local would help.

---

## 10. LOW — `prepareDiscussionUpload` duplicate-check is global, not per-teacher (UX, not security)

**File**
- `apps/web/src/lib/actions/prepare-discussion-upload.ts:42-49`

**Scenario**
The dedupe query:
```ts
let duplicateQuery = admin.from("discussions").select("id")
  .eq("canvas_assignment_id", canvasAssignmentId);
duplicateQuery = canvasSectionId
  ? duplicateQuery.eq("canvas_section_id", canvasSectionId)
  : duplicateQuery.is("canvas_section_id", null);
```
…runs via service-role admin client without filtering by `teacher_id`. The `discussions` table has a unique constraint `(canvas_assignment_id, canvas_section_id) NULLS NOT DISTINCT` (migration 20260516140000:20-21), which is GLOBAL across teachers. Two different teachers who happen to teach courses with overlapping Canvas assignment IDs (only possible if they share a Canvas course, which DOES happen at EHS for cross-listed sections) would race for the same row — the second one gets `"A recording is already linked to this assignment + section"` even though the existing record belongs to another teacher.

This is a UX bug, not a security one (the message reveals only "an assignment+section pair is taken" — no PII), and Canvas assignment IDs aren't readily collidable across teachers in practice. But the `unique nulls not distinct` constraint should arguably include `teacher_id` to truly scope discussions per teacher.

**Fix direction**
```sql
alter table discussions drop constraint discussions_assignment_section_unique;
alter table discussions
  add constraint discussions_assignment_section_unique
  unique nulls not distinct (teacher_id, canvas_assignment_id, canvas_section_id);
```
And add `.eq("teacher_id", teacher.id)` to the dedupe query.

---

## 11. INFO — `/api/inngest` is intentionally unauthed (Inngest cloud's signed POSTs)

**File**
- `apps/web/src/app/api/inngest/route.ts:7-14`

The `serve({ client, functions })` helper from `inngest/next` wraps the signing-key verification internally — `INNGEST_SIGNING_KEY` is the secret Inngest cloud signs every POST with. CLAUDE.md confirms `/api/inngest` returns 401 to unsigned GETs (line 70: "`/api/inngest` returns 401 to unsigned GETs (correct posture)"). The proxy passes this route through because it doesn't match `/dashboard/*` or `/admin/*` (`proxy.ts:21-22`). No finding — by design.

---

## 12. INFO — Public route map is tight; no accidentally-exposed admin paths

The proxy gates `/dashboard/*` and `/admin/*` (`proxy.ts:21-22`). Everything else is public:
- `/` — login page; renders publicly with `redirect("/dashboard")` for already-signed-in users (`page.tsx:21-24`).
- `/auth/login` — initiates OAuth.
- `/auth/callback` — completes OAuth with code → session exchange + email-domain check + service-role teacher upsert.
- `/auth/logout` — clears session (POST only).
- `/api/inngest` — signed by Inngest cloud.
- `/api/super-grader/result` + `/api/super-grader/prompt` — bearer-gated by `HARKNESS_API_TOKEN`.

Nothing accidentally bypassed. The proxy's optimistic-gate-only design (verified at `proxy.ts:24-29`) deliberately doesn't try to validate teacher-membership or admin-status — that's checked again at the page level via `getCurrentTeacher` / `getCurrentAdminEmail`, which is the correct posture per the Supabase SSR pattern.

---

## 13. INFO — `is_admin()` and `is_teacher_owner()` are properly granted to `authenticated`

Both helpers are `SECURITY DEFINER` with `set search_path = public, auth`, granted EXECUTE to `authenticated, service_role`, revoked from `public, anon`. Aligns with the migration template at the top of HH's CLAUDE.md. No drift.

---

## 14. INFO — Admin overlays on `teachers`/`students`/`discussions`/`participations` give admins read-everything

`migration 20260513120001:119-126` adds four `for select using (is_admin())` policies that overlay the teacher-owner ones. This is by design (admin console needs to see across teachers) BUT pairs poorly with finding #1 (plaintext tokens). Once tokens are encrypted at rest or moved off the row, this overlay is fine.

---

## 15. INFO — Email domain `@episcopalhighschool.org` enforced server-side on callback

`apps/web/src/app/auth/callback/route.ts:35-38` re-checks `email.endsWith("@episcopalhighschool.org")` after Supabase's `hd` hint, calling `supabase.auth.signOut()` if it doesn't match. Defense-in-depth against a user switching accounts mid-flow. Correct posture.

---

## 16. INFO — Teacher upsert in callback is idempotent on `(auth_user_id)`

`auth/callback/route.ts:76-89` upserts `teachers` on `onConflict: "auth_user_id"`. The column is `not null unique references auth.users(id)` (`migration 20260513120000:15`). Two concurrent first-callback hits race on insert; the second falls through to UPDATE via ON CONFLICT. No race-induced double-row creation possible. ✓

---

## Themes

The headline issue is **#1 plaintext Google refresh tokens on `teachers` rows**, accessible to any admin via the `teachers_admin_select` policy overlay — a curious admin can SELECT every teacher's `google_refresh_token` and durably impersonate them against Drive. The fix is structural: move tokens off the admin-readable surface (separate table whose RLS is `auth_user_id = auth.uid()` only) and/or encrypt at rest with a key the admin role doesn't have. AID encrypts its Canvas tokens; HH should match for Google. This maps to root cause #4 (fail-open default — admin overlay reads tokens that admins should not see).

The runner-up is **#2 timing-leakable bearer compare** at `lib/peers/auth.ts:21`, a copy-paste of the same vulnerability in HAH. The blast radius is broader for HH than for AID — once the SG bearer is recovered byte-by-byte, the attacker can pull every transcribed discussion's signed audio + full transcript + full summary by iterating `(canvas_user_id, canvas_assignment_id)` pairs. One-line fix with `timingSafeEqual`.

The five-root-cause lens:
- **#1 (no snapshot semantics)** — finding #5 (last-admin-lockout) and #6 (bootstrap race) both read-then-write without a row-level lock; both are easy with `for update` or `upsert ignoreDuplicates`.
- **#2 (no state fences)** — finding #5; finding #3 (teacher self-update) lets a teacher write columns the state machine considers system-set.
- **#3 (no transactional boundaries)** — finding #5 again.
- **#4 (fail-open defaults)** — finding #1 (admin overlay reads tokens), finding #2 (string compare leaks a byte at a time, fails open on partial match), finding #4 (admin layout gate without per-page gates assumes the layout chain stays intact).
- **#5 (no idempotency)** — finding #6 (bootstrap insert can dup-conflict-throw).

Inngest's durable steps (`transcribe-discussion.ts`) handle the rate-limit + transcribe + summary + push paths with retries and onFailure, which is good — that flow is the one place HH actively follows the idempotency pattern (`step.run` is durable). The leakage is in the auth/admin layer, not the pipeline.

### Setup-page divergence (verdict)

HH's `/dashboard/setup` page **drifts from AID in shape but not in critical UX**. Concrete drift points (referencing line numbers):
- HH has no top-of-section banner (AID `setup/page.tsx:34-65` vs HH lines 28-50, which inline the status in a `<dl>` table).
- HH has a Drive panel AID lacks (HH lines 77-123) — by design, HH needs per-teacher Drive scopes.
- AID has a `<CardTextEditor />` HH lacks (AID line 88-92) — by design, no card-text concept.
- AID has a "What we use the token for" rationale panel HH lacks (AID lines 94-114).
- HH has a Test Canvas button AID lacks (HH `TestCanvasButton.tsx`).
- HH has an admin-gated token-rotation help block AID lacks (HH lines 54-74).
- Different copy/framing in the page header (HH: "Verify the connections" vs AID: "We use your Canvas API token to read your courses…").

The two pages do the same JOB (setup connections) with different SHAPES. The feedback memory's strict reading would mark this MEDIUM-drift; a pragmatic reading would accept it because the per-app integrations differ legitimately (HH adds Drive; AID adds card text). The recommended fix is the lightweight one: lift a shared `<ConnectionStatus>` banner component into a shared package, use it twice on HH and once on AID, and call the rest of the divergence by-design. M7.2 is the right milestone for the harmonization.
