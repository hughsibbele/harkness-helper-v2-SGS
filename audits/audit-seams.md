# HH audit — cross-system seams (super-grader webhook / inbound / Inngest / Storage / retention / Sentry)

Date: 2026-05-22
Auditor: theme #5 of M6.22 (parallel audit campaign)
Scope: `apps/web/src/lib/peers/*`, `apps/web/src/app/api/super-grader/*`, `apps/web/src/app/api/inngest/route.ts`, `apps/web/src/lib/inngest/*`, `apps/web/src/lib/actions/{prepare,upload,delete}-discussion.ts`, `supabase/migrations/20260516120000_discussion_audio_bucket.sql`, retention surface (absent), Sentry (absent).
Reference layout: `handwritten-assignment-helper-v2-SGS/audits/audit-seams.md`.

Severity legend (matches reference): **CRITICAL** = silent webhook drop / Inngest stale-registration in prod / public bucket / no Sentry scrub at all. **HIGH** = retry storm / partial-success state mismatch / no retention surface. **MEDIUM** = TTL too long / partial-failure ergonomics. **LOW** = code-smell.

The five recurring root causes are referenced inline: (1) no snapshot semantics, (2) no state fence, (3) no transactional boundary, (4) fail-open instead of fail-closed, (5) no retry/idempotency.

---

## CRITICAL — `checkSuperGraderBearer` uses non-constant-time `!==`; gates BOTH inbound endpoints

**File:** `apps/web/src/lib/peers/auth.ts:21`

```ts
if (!match || match[1] !== expected) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

`!==` short-circuits on first byte mismatch. This single helper gates the two inbound system-to-system endpoints in HK:
- `GET /api/super-grader/result` — returns the full envelope including transcript text, summary text, signed audio URL with a 1-hour TTL.
- `GET /api/super-grader/prompt` — returns the live HK prompt body (transcription / summary / speaker_identification / individual_feedback).

Same shape as HAH's P1 finding. The token is `HARKNESS_API_TOKEN`, rotated only on incident per CLAUDE.md, so the attacker has time to byte-walk it from a low-noise vantage point.

**Cross-system failure mode.** Brute-force the bearer (timing oracle is the only side channel needed) → all four system prompt bodies become readable, AND the attacker can pull `{ transcript, suggested_summary, signed audio_url }` for any `(canvas_user_id, canvas_assignment_id)` pair they can guess. The transcript field is roster-scrubbed at write time (the audit-#2 byte-level concern), but the signed audio URL is NOT scrubbed — opening it within the 1-hour TTL streams the raw classroom recording (student voices, full names spoken aloud, free-text discussion content). Root cause 4 (fail-open).

**Fix direction.** Replace with `crypto.timingSafeEqual(Buffer.from(match[1]), Buffer.from(expected))` and length-guard first (`timingSafeEqual` throws on unequal lengths). One file fix.

---

## CRITICAL — `inngest.send` has no `id` (idempotency key); a single user upload can spawn parallel transcribe jobs

**File:** `apps/web/src/lib/actions/upload-discussion.ts:152-159`

```ts
try {
  await inngest.send({
    name: "discussion.uploaded",
    data: { discussionId },
  });
} catch {
  // Don't block the upload's success on a missing Inngest dev server.
}
```

No `id` on the send. Inngest dedups events by `id` when supplied; without it, retries from the SDK's network path, retries from Vercel's edge runtime invoking the action twice (rare but possible), or operator re-triggers via Inngest dashboard each enqueue a separate event with a distinct internal id. Each event spawns a separate `transcribe-discussion` run.

The `transcribe-discussion` function has an `if (discussion.state !== "uploaded") return { skipped: true }` guard at `transcribe-discussion.ts:85-90` that protects against the dominant doubled-up case, but the protection is racy:

- Run A loads the row, sees `state = "uploaded"`, proceeds.
- Run B loads the row, sees `state = "uploaded"` (Run A hasn't reached `mark-transcribing` yet because step.run gates are checkpoint-ordered but not cross-event-ordered), proceeds.
- Both call `mark-transcribing` (UPDATE without state fence), both pass.
- Both call Gemini Files API, both upload the audio, both burn the rate-limit RPC, both write `transcript` to the same row.
- `save-summary` then sets `state = "transcribed"` from both — last write wins, **transcript text comes from whichever Gemini response landed last**.

Crucially, `mark-transcribing` at `transcribe-discussion.ts:112-118` has NO state fence:
```ts
await admin.from("discussions")
  .update({ state: "transcribing", error_message: null })
  .eq("id", discussionId);
```
No `.eq("state", "uploaded")` so the UPDATE can't fail if another worker has already flipped the row. Root cause 2 (no state fence on UPDATE) compounding root cause 5 (no idempotency key on the event).

**Cross-system failure mode.** A teacher uploads a 30-min recording. Inngest cloud (post-Vercel-rename, before the operator runs `curl -X PUT /api/inngest`) re-tries the registration sync, and during a redeploy the upload server action runs twice (Next 16 action retries are framework-level — not impossible). Two parallel transcribe jobs run; the rate-limit RPC increments twice against the teacher's daily Gemini cap; two Gemini Files API uploads at $0.10-ish each; the final transcript is whichever job finished last (potentially with different text since Gemini is non-deterministic at temp > 0). Then `push-to-super-grader` fires twice, each per-participant fan-out hits SG's `/api/ingest/harkness` for every student — SG's upsert is idempotent so peer_results is clean, but HK's `super_grader_response` JSON is overwritten twice.

**Fix direction.**
1. Set `id: \`discussion-uploaded:${discussionId}\`` on the `inngest.send` payload. Inngest dedups within a 24h window on (name, id) — covers the realistic double-fire window.
2. Add a state fence to `mark-transcribing`: `.eq("state", "uploaded")` and check `data.length === 1` else `return { skipped: true }`.

---

## CRITICAL — No retention sweep exists; audio + transcripts accumulate indefinitely

**Files:** `apps/web/src/app/admin/` (no retention route), `apps/web/src/app/api/admin/` (does not exist at all), `apps/web/src/lib/actions/upload-discussion.ts:97` and `delete-discussion.ts:29` (both reference a "retention sweep" that does not exist).

HAH has `/admin/retention` with CSV export + chunked hard delete and a cleanup-photos Inngest cron (`apps/web/src/lib/inngest/functions/cleanup-photos.ts`). HK has neither:

```
$ find apps/web/src/app/admin
admin/layout.tsx, admin/page.tsx, admin/admins/*, admin/prompts/*
(no admin/retention/*)

$ find apps/web/src/app/api/admin
(directory does not exist)

$ find apps/web/src/lib/inngest
client.ts, transcribe-discussion.ts
(no cleanup function)

$ grep -rn "retention\|sweep\|cron\|cleanup" apps/web/src/
upload-discussion.ts:97  // ...retention sweep handles it.
delete-discussion.ts:29  // ...storage cleanup that follows fails...
```

The first comment (`upload-discussion.ts:97`) explicitly punts orphan-blob cleanup ("the unique constraint may have raced with another upload; leave the orphan blob in place — retention sweep handles it") to a sweep that doesn't exist.

**Cross-system failure mode.** A class records discussions for a full school year. Each ~30-min recording is ~30-60 MB. Across 5 sections × 20 weeks = 100 recordings = ~5 GB of audio. Across 4 years = ~20 GB. The `discussion-audio` bucket has no TTL, no lifecycle policy, no cron sweep, no admin "delete by date" UI. Per the dashboard's per-row delete (`delete-discussion.ts`) the teacher CAN delete one discussion at a time, but bulk year-end cleanup requires opening Supabase Studio directly — and even that doesn't ensure storage + DB stay in sync (`delete-discussion.ts:33-43` deletes the DB row first then best-effort removes the blob; on storage failure the row is gone but the blob lingers with no future reference). FERPA is the bigger problem: recordings of student voices and full-name utterances exist on disk indefinitely.

The dashboard view filters discussions by some recency window or none — at scale the dashboard hits the `participations → students` join across 100+ rows per teacher with no pagination guard at `envelope.ts:30-39`. The audit doesn't dive into the dashboard query but the absence of a retention floor means it grows monotonically.

Root cause 3 (no transactional boundary on delete-row-then-delete-blob) + missing-feature gap.

**Fix direction.**
1. Add `/admin/retention` mirroring HAH's pattern: CSV export of discussions older than N, chunked delete with "type DELETE" confirm.
2. Order the per-row delete `delete-discussion.ts` so storage `.remove()` runs first AND its result is checked; only delete the DB row if the blob is gone (or if the blob was already missing). Reverse of HAH's chosen order, but the right call when the DB row is the only durable pointer to find the blob (per `delete-discussion.ts:29` rationale comment which acknowledges the tradeoff but picks the wrong side: orphan blobs are *more* expensive than phantom rows when there's no later sweep to find them).
3. Add a `cleanup-old-blobs` Inngest cron that lists storage objects whose path doesn't match any current `discussions.audio_url` — guarantees orphans get reaped even if `delete-discussion` lost the blob.
4. Document a default retention policy ("audio + transcripts > N months are eligible for purge") in `/admin/retention`.

---

## CRITICAL — No Sentry instrumentation at all

**Files:** project root (`instrumentation.ts` / `instrumentation-client.ts` do not exist), `apps/web/src/lib/telemetry/sentry-init.ts` (does not exist), no `@sentry/*` imports anywhere.

CLAUDE.md "Env vars" section lines 195: `Sentry (optional): SENTRY_DSN, NEXT_PUBLIC_SENTRY_DSN`. The env-gating contract is documented but the wiring isn't.

```
$ grep -rn -l "sentry\|Sentry" --include="*.ts" --include="*.tsx" --include="*.json" .
(zero matches — Sentry not installed)
```

This is a different shape from HAH's "Sentry init has no `beforeSend` PII scrubber" finding. HK has no init at all, which means:

- A Gemini API exception including transcript context (the `gemini-transcribe` step at `transcribe-discussion.ts:154-210` has plenty of unscrubbed surface — `apiKey`, audioBlob mimeType, file URIs) will land in Vercel runtime logs only, with no centralized telemetry surface.
- The `pushDiscussionToSuperGrader` per-attempt failure path at `notify.ts:144-151` truncates response bodies to 500 chars and persists them in `discussions.super_grader_response` — but that's the only diagnostic for outbound webhook drops.
- The operational gotcha from suite memory (`feedback_inngest-resync-after-vercel-rename.md`) — events 200 silently but never fire — is *exactly* the class of issue Sentry would catch via alert-on-no-events-for-N-hours. Without Sentry, the only way to discover Inngest is stale is "first real classroom recording transcribed after 2026-05-17 stays stuck on `state='uploaded'` forever" (per CLAUDE.md's own "HK ↔ SG end-to-end is unexercised in production" caveat).

If/when Sentry is added later, **start with `beforeSend` from day one** — HK's call surface has the same PII shape as HAH (teacher Canvas token, Google access/refresh tokens on the teachers table, transcript text). Without a scrubber present at first init, the first exception leaks. Root cause 4 (fail-open by absence).

**Fix direction.**
1. Install `@sentry/nextjs`. Add `instrumentation.ts` + `instrumentation-client.ts` at repo root (Next 16 path), env-gated on `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`.
2. Implement `beforeSend` from the start: scrub Authorization + Cookie headers, scrub request body, redact extras matching `/token|password|secret|api_key|refresh/i`. The same shape HAH should retrofit.
3. Add a Sentry alert "no `transcribe-discussion` events for 12h on a weekday" — catches the silent-Inngest-drift class that suite memory says is happening across HAH/OE/HH on every rename.

---

## HIGH — `pushDiscussionToSuperGrader` partial-success state mismatch: state stays `transcribed` even when 9/10 participants posted

**File:** `apps/web/src/lib/peers/notify.ts:168-199`

The fan-out runs `Promise.all` over `canvasUserIds` (one POST per participant). The aggregator at lines 168-197:

```ts
const allOk = failed.length === 0 && postedFor.length > 0;
const update: {
  super_grader_post_status: "posted" | "error" | "pending";
  super_grader_response: Json;
  state?: "posted_to_super_grader";
} = {
  super_grader_post_status: allOk ? "posted" : failed.length > 0 ? "error" : "pending",
  ...
};
if (allOk) update.state = "posted_to_super_grader";
```

So if 9 of 10 participant POSTs succeed and 1 fails with HTTP 500, the row keeps `state = "transcribed"` (the discussion table's state) AND records `super_grader_post_status = "error"` with the 9 successes + 1 failure listed in `super_grader_response.posted_for` / `.failed`.

The retry path is then unclear:
- The Inngest function does NOT call `pushDiscussionToSuperGrader` again — it's a single step at `transcribe-discussion.ts:276-278` with no retry-on-this-step logic separate from the function's `retries: 2`.
- Because `push-to-super-grader` is wrapped in `step.run` and `pushDiscussionToSuperGrader` never throws (best-effort by design, per the comment at `notify.ts:32-39`), the step always succeeds from Inngest's view — `retries: 2` won't re-fire it.
- No admin retry button exists. The persisted diagnostic is "the future retry surface" referenced in the docstring but absent in code.

**Cross-system failure mode.** Teacher uploads a recording for an 11-student section. The push fan-out fires 11 POSTs to SG. One POST hits a transient SG 500 (rolling deploy, cold-start, network blip). The 10 successful posts populate SG's `peer_results` for those students; the 1 failed student gets nothing. HK persists `super_grader_post_status = "error"` and the diagnostic, but `state = "transcribed"` (not `"posted_to_super_grader"`). SG's grading view for that 1 student shows no Harkness card. SG's pull-on-view fallback (`/api/super-grader/result`) might catch it IF the teacher clicks through — but the route only returns the envelope for `state IN ('transcribed', 'posted_to_super_grader')` (`envelope.ts:34`), which DOES include the partial-failure case. So pull-on-view works as the safety net. The issue is: **no automatic retry of the failed push**, and the persisted error sits in a JSONB field with no UI surfacing it.

Root cause 5 (no retry/idempotency on the outbound webhook) + root cause 2 (no state fence — the state can't represent "partially pushed" so it just lies as `transcribed`).

**Fix direction.**
1. Add a `super_grader.retry_push` Inngest function triggered by an admin button OR a cron that scans `discussions` where `super_grader_post_status = 'error'` AND `state = 'transcribed'` AND `updated_at < now() - interval '5 minutes'`.
2. Set `id` on each `inngest.send` for the retry to dedup.
3. Add an admin row to `/admin` surfacing the count of stuck-push discussions.
4. SG-side: confirm `/api/ingest/harkness` is upsert-idempotent on `(peer, canvas_user_id, canvas_assignment_id)` (it is — see `super-grader-v2-SGS/apps/teacher/lib/peers/server.ts:178` `.upsert(`) so a retry of the 10 already-posted students is a no-op.

---

## HIGH — Outbound POST has no idempotency key in the envelope; SG-side dedup hangs on `(peer, canvas_user_id, canvas_assignment_id)` only

**File:** `apps/web/src/lib/peers/envelope.ts:86-103`, `apps/web/src/lib/peers/types.ts:14-25`

HK's envelope shape:
```ts
{
  schema_version: 1,
  peer: "harkness",
  canvas_user_id, canvas_assignment_id,
  anon_token, completed_at,
  summary: { audio_url, transcript, suggested_summary },
  links: { detail_url: `${appUrl}/dashboard` },
}
```

The integration contract §4 (lines 99-114 of `super-grader-v2-SGS/planning/integration-contract.md`) requires exactly these fields. **Envelope shape matches.** SG's `validatePeerEnvelope` at `super-grader-v2-SGS/packages/peers/src/index.ts:121-179` validates every required field; HK's builder hits each. ✓

BUT: there is no `idempotency_key` in either the contract or the envelope. SG dedups on the natural key `(peer, canvas_user_id, canvas_assignment_id)` via the upsert in `peer_results`. This is *fine* for the "two pushes of the same content" case, but it's wrong for the "re-recording" case:

**Re-record scenario.** Teacher records the discussion, transcribes, pushes to SG. SG has the envelope. Teacher realizes audio quality was bad, deletes the discussion (`delete-discussion.ts`), re-records the same `(canvas_assignment_id, canvas_section_id)` pair. New discussion row, new transcription, new push. SG's `peer_results` is upserted to the new content — correct outcome.

**Stale-retry scenario (the failure).** The first push partially fails (per the HIGH above). Operator manually fires the retry. Meanwhile, the teacher edited the summary in SG (per integration-contract §5: "super-grader is the canonical editing surface" for the harkness summary). The retried HK push includes the original `suggested_summary` (which has not been edited in HK because HK doesn't expose summary editing). SG's upsert clobbers the teacher-edited summary back to the AI-suggested one.

The contract §5 line 150 says explicitly: *"The teacher's edit of the satellite-AI-generated harkness summary (the edited text *is* the Canvas comment)."* But SG's `peer_results.summary` field is where the satellite payload lands; the teacher's edits go to a different surface (`gradings.comment` per integration-contract §5 line 156). So this may actually be safe — needs SG-side verification. Documenting as HIGH so the M6.23 SG audit can confirm: does SG store the teacher's edited harkness summary on a separate column from `peer_results.summary.suggested_summary`? If yes, the retried HK push only overwrites the AI-suggested copy and the teacher's edit on `gradings.comment` survives. If no, the retry destroys teacher work.

Root cause 5 (no idempotency on the satellite side; dedup is "last write wins" by composite key).

**Fix direction.**
1. Add `envelope.idempotency_key` (e.g. `${discussionId}:${updatedAt}`) and bump `schema_version` to 2. SG can use it to reject stale retries when `idempotency_key` is older than what's already cached.
2. Cross-system: confirm SG's `peer_results.summary` is read-only from the teacher's view and the teacher-edited summary lives on `gradings.comment`. If the teacher CAN edit `peer_results.summary` directly, the satellite push must include a "don't overwrite teacher-edited" sentinel.

---

## HIGH — Per-attempt 5s timeout × N participants × wall clock; slow SG can wedge the transcription job

**File:** `apps/web/src/lib/peers/notify.ts:5, 132-156`

```ts
const TIMEOUT_MS = 5_000;
```

The fan-out uses `Promise.all`, so all participant POSTs run in parallel. Each POST has a 5s `AbortController`. For a typical 10-student section, that's ~5s wall clock for the whole step. So this isn't a literal wedge today.

BUT: the function's outer `retries: 2` (transcribe-discussion.ts:52) means if any earlier step transiently fails, the function reruns from the failed step. The `push-to-super-grader` step is `step.run`-checkpointed, so on retry it WILL re-fire the fan-out (Inngest's step.run is keyed on its name, and on retry the cached output is used IF the step succeeded). Since `pushDiscussionToSuperGrader` always returns (never throws), the step is always considered successful, so on retry it should not re-fire — the cached PushOutcome is reused. ✓

The real issue is the AbortController behavior. The reference HAH audit's `pushToSuperGrader` finding (P2 — `notify.ts:48-71`) noted "no retry, single 5s fetch." HK improves on this by recording failures into `super_grader_response` (HAH doesn't), but **per the integration contract §4 there's no retry budget defined**, so the 5s timeout × no-retry on a slow SG cold-start means a freshly-deployed SG (Vercel cold-start can be 2-4s) makes the POST land near the timeout. Single try fails → silent partial-failure state per the HIGH above.

Root cause 5 again (no retry budget).

**Fix direction.**
1. Bump per-POST timeout to 15s OR add a per-POST retry with exponential backoff inside the fan-out.
2. Better: move the entire push into its own Inngest function `super-grader.push` that fires from `transcribe-discussion` via `step.sendEvent`. Inngest's per-function retry policy handles backoff; HK's transcription job stays clean.

---

## HIGH — Storage bucket has no RLS policies; signed-URL pattern is the only barrier

**File:** `supabase/migrations/20260516120000_discussion_audio_bucket.sql:1-23`

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'discussion-audio',
  'discussion-audio',
  false,                              -- private bucket ✓
  104857600,                          -- 100 MB
  array['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav']
);
```

Explicit comment at lines 9-11: *"No RLS policies on storage.objects for this bucket: service-role bypasses RLS for writes, and signed URLs bypass RLS for reads (the signed token is the authorization)."*

This is workable BUT relies entirely on:
1. Every read path going through `createSignedUrl` (verified: `envelope.ts:79-83`, `transcribe-discussion.ts:158-163`).
2. Every write path being initiated server-side via `createSignedUploadUrl` with a teacher-scoped path (verified: `prepare-discussion-upload.ts:60-65`).
3. The `finalizeDiscussion` action validating the storage path starts with the teacher's id (verified: `upload-discussion.ts:40-42`).

**Path-traversal check.** `prepare-discussion-upload.ts:60-61`:
```ts
const sectionSlug = canvasSectionId ?? "no-section";
const storagePath = `${teacher.id}/${canvasAssignmentId}/${sectionSlug}/recording.${ext}`;
```

The path is generated server-side from `teacher.id` (from auth) + `canvasAssignmentId` (client-supplied) + `canvasSectionId` (client-supplied) + `extensionForMime(audioMimeType)` (whitelisted). Client-supplied `canvasSectionId` is NOT validated against the teacher's roster — a malicious teacher could supply `../other-teacher-uuid/...` as `canvasSectionId` to traverse out of their own prefix. Let's check the validation in `prepare-discussion-upload.ts:27-32`:

```ts
const canvasSectionId =
  params.canvasSectionId && params.canvasSectionId.trim().length > 0
    ? params.canvasSectionId.trim()
    : null;
```

No regex check, no `assert(/^\d+$/.test(canvasSectionId))`. **A `canvasSectionId` containing `..` or `/` would be string-concatenated directly into the path.** Then `finalizeDiscussion` at `upload-discussion.ts:40` only checks `startsWith(teacher.id + "/")` — a path like `${teacher.id}/../OTHER-TEACHER/${canvasAssignmentId}/...` does NOT start with `teacher.id + "/"` (it starts with the literal `teacher.id/`), wait — actually the check would pass for `${teacher.id}/something/../OTHER/...` since startsWith only checks the prefix. Let me re-read:

The generated path is `${teacher.id}/${canvasAssignmentId}/${sectionSlug}/recording.${ext}`. If `canvasSectionId = "../OTHER-TEACHER/junk"`, the path becomes `${teacher.id}/${canvasAssignmentId}/../OTHER-TEACHER/junk/recording.mp4`. Supabase Storage may normalize the `..` server-side OR may not — needs verification, but assume worst case. The `startsWith(teacher.id + "/")` check at finalize PASSES (prefix is literal). So an attacker who controls a teacher account could traverse out of their prefix.

Similarly `canvasAssignmentId` is untrusted and could contain slashes or `..`. There's a `.trim()` but no character class check.

Root cause 4 (fail-open: assumes string-concatenated path is safe without validating components).

**Cross-system failure mode.** Teacher A (legitimate but malicious) sends a tampered `finalizeDiscussion` payload with `canvasSectionId = "../<teacher-B-uuid>/<their-real-assignment>/<their-real-section>"`. The signed upload URL was issued in `prepare-discussion-upload` for the path *as generated*. The signed URL is bound to the literal path string, so the PUT only works at that exact path. **However**, if Supabase Storage normalizes `..` server-side, the actual write goes to teacher B's prefix and overwrites their recording. Even if Supabase doesn't normalize, the row in `discussions.audio_url` references the un-normalized path which the read-side `createSignedUrl` re-signs — the read also resolves to the wrong location. The bucket's lack of an RLS policy means there's no row-level "name must start with teacher's uuid" enforcement at storage level.

**Fix direction.**
1. Add input validation in `prepare-discussion-upload.ts`: assert `canvasAssignmentId` and `canvasSectionId` match `/^\d+$/` (Canvas ids are integer strings). Reject otherwise with a 400 before issuing the signed URL.
2. Optionally add an RLS policy on `storage.objects` for the `discussion-audio` bucket:
```sql
create policy "tenant-scoped audio reads" on storage.objects
  for select to authenticated
  using (bucket_id = 'discussion-audio' AND (storage.foldername(name))[1] = auth.uid()::text);
```
Even though service-role bypasses RLS, an RLS policy adds defense in depth if someone ever issues a non-signed read path.
3. Verify Supabase Storage's path normalization behavior — needs a smoke test with a deliberately crafted `..`-laden upload to confirm.

---

## HIGH — `/api/inngest` registration has no documented post-rename PUT runbook in the repo

**Files:** `apps/web/src/app/api/inngest/route.ts` (the serve endpoint), `apps/web/src/lib/inngest/client.ts`, no migration runbook, no `scripts/` content, no README mention.

Suite memory `feedback_inngest-resync-after-vercel-rename.md` documents the bug exhaustively. CLAUDE.md at the suite root has a long paragraph on it. But the HH-local CLAUDE.md mentions it only obliquely (lines 68-70: *"/api/inngest returns 401 to unsigned GETs (correct posture)"*), and the HH repo itself has:

```
$ find harkness-helper-v2-SGS -name "*.sh" -o -name "README*" | grep -v node_modules
README.md  (only repo-level, no curl PUT mention)
$ grep -rn "PUT /api/inngest\|curl -X PUT" harkness-helper-v2-SGS/
(zero matches)
```

So after any Vercel rename/recreate (which has happened to HH per the suite memory — the suite-level CLAUDE.md notes the URL truncation surprise that happens to HH's siblings) the operator must remember to:
```
curl -s -X PUT https://harkness-helper-v2-sgs.vercel.app/api/inngest
```
Without it, `inngest.send({ name: "discussion.uploaded" })` returns 200 silently, the event lands in Inngest cloud, but Inngest tries to POST the function invocation to the OLD URL which 404s — discussion stays `state='uploaded'` forever.

This is operational, not code, but it's load-bearing for the whole transcription pipeline. The 2026-05-17 Phase D note in CLAUDE.md acknowledges *"HK ↔ SG end-to-end is unexercised in production"* — combined with this gap, the first real classroom recording is *expected* to trigger this bug.

Root cause 5 (no idempotency / no health-check on the deploy path).

**Fix direction.**
1. Add a `scripts/inngest-resync.sh` at repo root or suite root that PUTs `/api/inngest` for HH/OE/HAH in one command.
2. Add a `GET /api/admin/inngest-status` route that fetches Inngest's API for the registered URL and compares to `process.env.VERCEL_URL` — surface a "stale registration" badge on `/admin` when they differ.
3. Add a Vercel-deployment-hook that fires `curl -X PUT $DEPLOYMENT_URL/api/inngest` automatically post-deploy. Inngest supports this via their Vercel integration; verify it's enabled.

---

## MEDIUM — Audio signed URL TTL is 1h; server-to-server fetch could use 5-min

**File:** `apps/web/src/lib/peers/envelope.ts:5, 79-83`

```ts
const AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 60;
```

SG calls HK's `/api/super-grader/result` and caches the response (per `peer_results` upsert). The signed audio URL in the envelope is then handed to the teacher's browser when they open the grading page. If the teacher opens the page > 1h after SG fetched the envelope, the URL expires and audio won't play — SG must re-fetch.

For a server-to-server pull this is fine. But the envelope's audio URL also flows to the browser when SG renders the harkness card. The 1h TTL is then a UX cliff. CLAUDE.md at lines 50-51 acknowledges: *"signs the audio URL with a 1-hour TTL... Super-grader is expected to re-fetch the envelope if the URL expires before the teacher plays it."*

This is a known design choice, but the SG `peer_results` cache TTL and HK's 1h URL TTL aren't coordinated. If SG caches `peer_results` for > 1h (looking at `super-grader-v2-SGS/apps/teacher/lib/peers/server.ts` reveals a Supabase row with no TTL — i.e., until explicit re-fetch), the audio URL in the cached envelope will be stale for the typical teacher who grades a week after the discussion.

Mitigations:
- SG's grading view should detect expired audio URL (URL contains an `Expires=` query param SG can parse) and re-fetch the envelope.
- Or HK could return a *fresh-on-every-request* signed URL via `/api/super-grader/result` — verified yes, the route at `result/route.ts:19-22` calls `buildHarknessEnvelopeForCanvasIds` which re-signs every time. So pull-on-view fixes it.

The actual MEDIUM: the outbound webhook (`notify.ts → /api/ingest/harkness`) also includes a signed URL with the same 1h TTL. SG persists that envelope into `peer_results` and may use the cached URL until the next view-driven re-fetch. If SG never re-fetches (e.g. teacher opens the page within the cached window), they see the audio URL that's now expired.

Root cause 1 (no snapshot semantics — the URL embeds a TTL that's invisible to SG).

**Fix direction.**
1. Lower the outbound-webhook envelope's audio TTL to 5 minutes (server-to-server is immediate; the inbound endpoint can re-issue fresh URLs on demand).
2. Or strip the audio URL from the outbound envelope entirely and force SG to always pull via `/api/super-grader/result` to get a fresh URL.
3. Or document in the integration contract that audio URLs are short-lived and SG MUST re-fetch envelopes on view.

---

## MEDIUM — `super_grader_post_status = "pending"` is unreachable; dead state

**File:** `apps/web/src/lib/peers/notify.ts:186-190`

```ts
super_grader_post_status: allOk
  ? "posted"
  : failed.length > 0
    ? "error"
    : "pending",
```

`"pending"` is reached when `allOk` is false AND `failed.length === 0`. That happens iff `postedFor.length === 0` AND `failed.length === 0`, i.e., the fan-out attempted ZERO participants. The only way to reach this branch:
- The participations query at `notify.ts:71-93` returned an empty list (no participants on the discussion).
- The dedup logic at lines 83-93 filtered everything out.

In practice, a discussion with no participants is a row-creation bug — the upload flow at `upload-discussion.ts:105-149` only inserts participations IF `participantIds.length > 0`, but the dashboard requires at least one participant before enabling the upload button. So a zero-participant discussion shouldn't exist in practice.

If it does (e.g. data fix-up, future feature), `super_grader_post_status` would be `"pending"` forever — but `state` would also stay `"transcribed"` (allOk is false, so no state flip), and the discussion would look like a legitimate "queued for push" row. No future code re-fires the push. The status string is misleading: it suggests "we'll try later" when in fact nothing will try later.

Root cause 4 (fail-open with a misleading marker).

**Fix direction.**
1. Either make the "no participants" branch a distinct status (`"empty"` or `"skipped"`) so it doesn't look like a queued push.
2. Or refuse to allow zero-participant discussions at the upload-action level (`upload-discussion.ts` already requires participants in the UI flow — assert server-side too).

---

## MEDIUM — Prompt endpoint version derivation is non-monotonic across clock skew

**File:** `apps/web/src/app/api/super-grader/prompt/route.ts:53`

```ts
const version = Math.floor(new Date(row.updated_at).getTime() / 1000);
```

`updated_at` is a Postgres `timestamptz`. If the DB clock skews backward (NTP correction, manual fix-up), a later save could produce a smaller `version` than an earlier one. SG's prompt cache compares versions to detect "should I refetch?" — a non-monotonic version would cause SG to think the prompt rolled back and miss new content.

The integration contract §11 schema spec defines `version int` as monotonic, bumped on save. HK derives it from `updated_at` because HK's prompts table doesn't have a `version` column (CLAUDE.md lines 52-56 acknowledges this). It works in the happy path but isn't strictly monotonic.

Also: epoch seconds rounds down. Two saves within the same second produce the same version. Rare in practice but possible with bulk seeding.

Root cause 1 (no snapshot semantics — `updated_at` is not a versioning primitive, it's a timestamp).

**Fix direction.**
1. Add a `version` column to HK's `prompts` table, bumped via trigger or via an explicit RPC on every UPDATE.
2. Or use `updated_at`'s microsecond precision (`Math.floor(new Date(updated_at).getTime() * 1000)` — Postgres has microsecond resolution).
3. Until the column is added, document the contract caveat ("HK derives version from `updated_at` — strictly increasing PER prompt key under normal clock conditions, may not be monotonic under clock skew").

---

## MEDIUM — `/api/super-grader/result` 30s cache is fine for SG, but is the only knob in either direction

**File:** `apps/web/src/app/api/super-grader/result/route.ts:30-32`

```ts
return NextResponse.json(envelope, {
  headers: { "Cache-Control": "private, max-age=30" },
});
```

30s `private` cache. SG burst-pulls (e.g. dashboard re-render across multiple students) get a free ride. After 30s, every view re-pulls and re-signs the audio URL. Acceptable.

But: there's no `ETag` or `If-None-Match` short-circuit. Every re-fetch re-runs the discussions + participations join + storage signing. For SG's pull-on-view fallback (per integration-contract §4: "5xx — peer is down. super-grader logs, hides the card with a small 'peer unavailable' badge, retries on next page load"), repeated polling on a stuck discussion is unbounded.

Root cause 5 (no idempotency — same query, full work every time).

**Fix direction.**
1. Add an `ETag` derived from `discussion.id || updated_at` and respond 304 on match. SG would need to send `If-None-Match` to benefit — coordinate via the integration contract.
2. Lower-priority since the cost per call is small (one indexed query + one signed-URL mint).

---

## LOW — `notify.ts` participations query may double-count when a student appears in two sections

**File:** `apps/web/src/lib/peers/notify.ts:71-93`

```ts
const seen = new Set<string>();
canvasUserIds = ((participations ?? []) as unknown as Row[])
  .map(...)
  .filter((id): id is string => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
```

Dedupe by `canvas_user_id` ✓. Won't double-POST for the same student. Correctly handled. Just noting as audited.

---

## LOW — Inngest send wrapper swallows ALL errors silently

**File:** `apps/web/src/lib/actions/upload-discussion.ts:152-159`

```ts
try {
  await inngest.send({...});
} catch {
  // Don't block the upload's success on a missing Inngest dev server.
}
```

The catch swallows everything, not just the "missing dev server" case. If Inngest's event key is misconfigured in prod (rotated, mistyped, expired), the upload appears to succeed (returns `{ ok: true, discussionId }`) but the transcription never fires. The dashboard shows `state='uploaded'` forever.

This is mitigated by suite memory (`feedback_webhook-silent-fail-enumerate-operational-first.md` — the operational checklist) but the code itself is fail-open.

**Fix direction.** Distinguish dev-server-missing (acceptable) from auth-failure (alarm-worthy). `inngest.send` throws different shapes for each; pattern-match and re-throw on the latter.

---

## Summary of state-fence / fail-open / idempotency / retention / Sentry posture

| Mechanism | State fence? | Fail-open? | Idempotent? |
|---|---|---|---|
| `/api/super-grader/result` | reads `transcribed/posted_to_super_grader` only ✓ | bearer required (non-constant-time, CRITICAL) | safe (read-only); no ETag |
| `/api/super-grader/prompt` | n/a | bearer required (non-constant-time, CRITICAL) | safe (read-only); 10-min cache |
| `pushDiscussionToSuperGrader` outbound | reads `transcribed` ✓ | silent no-op when SG env unset ✓ (correct) | **NO retry, no idempotency_key**; partial-success doesn't flip state |
| Inngest `transcribe-discussion` | state guard at function entry (`!== 'uploaded'`) but `mark-transcribing` UPDATE has NO state fence | rate-limit RPC throws (fail-closed ✓); push step never throws (fail-open ✓ on purpose) | **NO `id:` on inngest.send** — duplicate events spawn parallel runs |
| `/api/inngest` registration | n/a | 401 on unsigned GET ✓ | **stale post-Vercel-rename — no in-repo runbook** |
| Storage `discussion-audio` bucket | no RLS (signed-URL pattern only) | path components not validated — traversal risk | n/a (write-only via signed URL) |
| `delete-discussion` per-row | n/a | DB row deleted before blob — orphan blob possible | yes |
| Retention sweep | n/a | **DOES NOT EXIST** | n/a |
| Sentry init | n/a | **DOES NOT EXIST** | n/a |

---

## Themes

The HK seams are in a slightly earlier maturity than HAH's — same shape on the inbound auth (constant-time compare missing), same shape on the outbound retry story (single-shot, persisted diagnostic but no automated retry), same shape on the Inngest stale-registration operational gap, **worse shape on retention (nonexistent vs HAH's `/admin/retention`) and Sentry (nonexistent vs HAH's env-gated init)**, and a new class of finding around Inngest event-id idempotency that HAH may also share but wasn't surfaced in the HAH audit (worth a back-port). The integration-contract §4 envelope shape is a clean match — all required fields present, no drift. The Phase D push pipeline is well-instrumented (per-attempt diagnostic in `super_grader_response`) but the diagnostic feeds no retry surface. Five recurring root causes mapped: state-fence gap on `mark-transcribing` (root cause 2), no transactional boundary on `delete-discussion` (root cause 3), fail-open at every inbound endpoint via non-constant-time bearer (root cause 4), idempotency missing on both `inngest.send` and the outbound push (root cause 5), no snapshot semantics on signed-URL TTLs versus SG's cached envelope (root cause 1). The most actionable single change is the `crypto.timingSafeEqual` swap at `auth.ts:21` — one line, closes two endpoints simultaneously. The second most actionable is adding `id:` to the `inngest.send` payload — one line, defends every downstream step from accidental parallelism. The largest gap is the absence of any retention surface for student audio — a FERPA-shaped problem that grows monotonically.
