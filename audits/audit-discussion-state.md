# HH Audit — Discussion state machine, audio pipeline, RLS

**Date:** 2026-05-22
**Auditor:** Claude (Opus 4.7, 1M context) — sub-audit
**Scope:**
- `apps/web/src/lib/inngest/transcribe-discussion.ts`
- `apps/web/src/lib/inngest/client.ts`
- `apps/web/src/app/api/inngest/route.ts`
- `apps/web/src/lib/actions/upload-discussion.ts`
- `apps/web/src/lib/actions/prepare-discussion-upload.ts`
- `apps/web/src/lib/actions/delete-discussion.ts`
- `apps/web/src/lib/actions/upload-discussion.types.ts`
- `apps/web/src/lib/actions/delete-discussion.types.ts`
- `apps/web/src/app/dashboard/RecordingFlow.tsx`
- `apps/web/src/app/dashboard/Recorder.tsx`
- `apps/web/src/app/dashboard/DeleteDiscussionButton.tsx`
- `apps/web/src/app/dashboard/DiscussionList.tsx`
- `apps/web/src/app/dashboard/page.tsx`
- `apps/web/src/lib/peers/notify.ts`
- `apps/web/src/lib/peers/envelope.ts`
- `apps/web/src/lib/peers/auth.ts`
- `apps/web/src/app/api/super-grader/result/route.ts`
- `apps/web/src/lib/super-grader/scope.ts`
- `apps/web/src/lib/actions/save-to-drive.ts` (state-relevant reads only)
- `packages/anonymizer/src/index.ts`
- `packages/prompts/src/index.ts`
- `supabase/migrations/20260513120000_initial_schema.sql`
- `supabase/migrations/20260513120001_admins_and_prompts.sql`
- `supabase/migrations/20260513120002_canvas_cache.sql`
- `supabase/migrations/20260513120003_gemini_rate_limits.sql`
- `supabase/migrations/20260516120000_discussion_audio_bucket.sql`
- `supabase/migrations/20260516130000_course_roster_sections.sql`
- `supabase/migrations/20260516140000_discussion_per_section.sql`
- `supabase/migrations/20260516150000_teacher_google_tokens.sql`
- `supabase/migrations/20260516160000_two_pass_transcript_summary.sql`
- `supabase/migrations/20260516170000_v1_prompts.sql`

**Reference:** Mirror of M6.19 OE / M6.20 AID / M6.21 HAH campaigns. Same five suite-wide root causes:
1. No snapshot semantics (live FK reads at confirm/transcribe time)
2. No state fences on UPDATEs
3. No transactional boundaries across subsystems (DB + Gemini + Storage + super-grader)
4. Fail-open instead of fail-closed
5. No retry/idempotency on user-visible mutations

---

## CRITICAL

### C1 — Empty/missing roster causes scrub to silently no-op → real student names land in DB transcript and ship to super-grader

**Files:**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:125-150` — roster lookup in `load-prompts-and-roster`. `maybeSingle()` on `course_rosters` returns `null` when no row matches (teacher hasn't synced this course, or the row was wiped, or the canvas_course_id doesn't match the row's because of a Canvas course-id format drift).
- `apps/web/src/lib/inngest/transcribe-discussion.ts:132-143` — when `rosterRow` is null, the optional-chain `rosterRow?.students` evaluates to undefined → `Array.isArray(undefined)` is false → `rosterStudents` becomes `[]` → `roster` becomes `[]`. **No error is raised. No log line. The job continues with an empty roster.**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:212-214,252-257` — `scrubText(rawTranscript, ctx.roster)` and `scrubText(rawSummary, ctx.roster)`.
- `packages/anonymizer/src/index.ts:50-64` — `scrubText` iterates the roster; with an empty array the loop body never executes, returning `text` unchanged.
- `packages/anonymizer/src/index.ts:57` — `if (!s.name.trim()) continue;` — additionally skips any roster student whose `name` is whitespace-only. (Combined with the email-filter at `transcribe-discussion.ts:135-138` discarding null-email students, the effective scrubber roster can be smaller than the visible roster.)

**Root cause:** Fail-open (#4) — the most expensive bleed in the audit. Combined with no transactional boundary (#3): the roster is loaded live at job time, not snapshotted at upload time, so a separate failure mode kicks in if a roster sync runs concurrently with the job (see C2).

**Failure scenario A — fresh teacher, no roster yet.**
1. Teacher signs in, gets to `/dashboard`, syncs Canvas. The course roster sync writes a row to `course_rosters` per course.
2. **But there are several non-trivial paths to a missing roster row:** the teacher recorded *immediately* after sign-in without syncing, the course sync errored (Canvas 429 partial failure, login_id-vs-email gotcha from the suite memo), or the teacher recorded against a Canvas course they don't own (data fix-up scenarios).
3. Recording uploads, finalizeDiscussion runs. finalizeDiscussion has its OWN roster lookup at `upload-discussion.ts:66-78` — if the row is missing, `rosterRow?.students` is undefined → `roster` is `[]`. **The discussion is created and the Inngest event fires anyway** — no fail-closed at upload time either.
4. Inngest worker runs. load-prompts-and-roster sees an empty roster. Gemini transcribes; despite the prompt asking it to anonymize, Gemini DOES sometimes leak real names (it's a 30-second audio sample of teenagers calling each other "Sarah", "Marcus"; the model has those token-frequent first-names in its vocabulary, not the prompt's `Student_xxxxxx` token shape).
5. Pass-2 scrub runs against empty roster → no replacements. **Real first names persist into `discussions.transcript`.**
6. Pass-2 summary uses the not-yet-scrubbed transcript as the model input — Gemini may surface those names in the summary too.
7. Final scrub against empty roster → still no replacements. **`discussions.summary` saved with real names.**
8. push-to-super-grader runs. Envelope `transcript` and `suggested_summary` contain real student names. SG persists the FERPA-leaked transcript per-participant.

**Failure scenario B — null-email-roster.**
- Per the suite memo in `~/.claude/projects/.../MEMORY.md`: Canvas `/enrollments?include[]=user` can return `email=null` and the previously-shipped HH version stored login_id as a fake email. The fix at HH commit `c2f7b3c` switched the sync to use `/courses/:id/users?include[]=email`. **But that fix doesn't reject login_id rows — it just hopes the new endpoint returns the right field.**
- If even one student in the roster has `email = null` (the new endpoint *does* expose email but for some students email visibility may still fail per Canvas permission gates), the filter at `transcribe-discussion.ts:135-138` drops them. Their name never gets scrubbed. Real name leaks.

**Failure scenario C — roster sync deletes a student between upload and transcribe.**
- Teacher records → finalize → Inngest event queued → roster sync runs concurrently (cron / manual refresh) → student is dropped from the roster jsonb (they dropped the class). The Inngest worker runs against the new roster. The student spoke in the audio, was on the OLD roster, but the NEW roster doesn't include them. Their name is not scrubbed. Leak.

**Suggested fix.**
1. **Fail-closed.** If `roster.length === 0`, throw at the top of load-prompts-and-roster — the job fails, onFailure marks `state='failed'` with a clear message ("roster empty — sync your Canvas course before transcribing"). The teacher can retry after syncing.
2. **Snapshot.** At finalize time (`upload-discussion.ts`), persist the canonical roster slice (`name`, `canvas_user_id`, `email`) onto a new column `discussions.scrubber_roster_snapshot jsonb`. The Inngest worker reads from this snapshot, not from live `course_rosters`. Edits to the roster after recording cannot retroactively unscrub anything.
3. **Reject null-email students earlier.** finalizeDiscussion currently filters out null-email students from `participations` (line 105-119) but does NOT reject the upload as a whole if a participant lacks email. A discussion can be created with 0 participants if all selected students had null email — leak risk goes up because no anon_token gets minted for that student. Surface a UI error: "X student(s) couldn't be added because their email is missing — fix in Canvas sync first."
4. Add a DB CHECK constraint: `state IN ('transcribed','posted_to_super_grader')` implies `transcript IS NOT NULL` (and roster_snapshot IS NOT NULL once snapshot lands).

---

### C2 — Prompt body is read live at Inngest job time, not snapshotted at upload time → admin's mid-job auto-save retroactively changes which prompt produced an existing transcript

**Files:**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:120-151` — `load-prompts-and-roster` step calls `getActiveTranscriptionPrompt()` and `getActiveSummaryPrompt()` at job-start time.
- `packages/prompts/src/index.ts:16-33` — both helpers do a fresh `SELECT` from `prompts` on each call, no cache.
- `apps/web/src/app/admin/prompts/PromptEditor.tsx` — admin's transcription/summary prompt editor uses the suite-wide auto-save pattern (per the CLAUDE.md memo: "800ms debounced typing + immediate save on blur" — confirmed by `apps/web/src/components/auto-save/useAutoSaveForm.ts`).
- `apps/web/src/lib/inngest/transcribe-discussion.ts:218-227,259-269` — saves `transcription_prompt_id` and `summary_prompt_id` onto the discussion AFTER the Gemini call, using the same `ctx.transcriptionPromptId` it loaded at job-start. The FK relationship correctly points at the row that was used; but the row's `body` may have been mutated by the time the row is finally written.

**Root cause:** No snapshot semantics (#1) — direct mirror of OE/AID/HAH C-tier finding.

**Failure scenario.**
1. Teacher uploads a 50-min Harkness recording. finalizeDiscussion creates row state='uploaded'. Inngest event queued.
2. Cold-start delay: the Vercel function spins up; Inngest's `transcribe-discussion` actually starts ~30s later.
3. In that window, an admin opens `/admin/prompts` and rewrites the transcription prompt. Auto-save commits 800ms after their last keystroke. `prompts.body` is mutated in-place. `prompts.updated_at` bumps. `prompts.id` stays the same.
4. Inngest worker reaches load-prompts-and-roster. Reads the NEW prompt body. Gemini transcribes against the new prompt.
5. discussions row is written with `transcription_prompt_id = <stable id>`. The row says "this transcript was made with prompt X" — and indeed prompt X exists — but the body of prompt X has changed since recording.
6. **Auditability is broken.** A teacher who reviews the transcript and disagrees with its style can't see what prompt the system actually used. The admin's edit retroactively re-attributes every in-flight transcript.

**Failure scenario B — partial mid-job edit.**
1. Same setup. Admin edits the transcription prompt while load-prompts-and-roster step is RUNNING (it's two parallel reads in Promise.all). The summary prompt happens to be cached / read first.
2. The transcription prompt is read mid-edit. Whether it returns the pre-edit or post-edit body depends on whether the auto-save's DB commit landed before this SELECT. There's no read-consistency boundary between the two.
3. Now the two passes can use prompts from different points in time. If the admin was tightening the anonymization language, only one pass gets the tightening.

**Failure scenario C — admin deletes the default prompt mid-flow.**
- `getActiveSystemPrompt` uses `.single()` (`prompts/src/index.ts:27`). If the admin somehow drops the is_default flag mid-job (e.g., editing UI clears it before re-setting on a different row), the SELECT returns 0 rows → throws. The Inngest step throws → retries 2x → exhausted → onFailure flips `state='failed'`. The teacher's recording is lost in the gutter.
- `apps/web/src/lib/inngest/transcribe-discussion.ts:54-67` — onFailure handler. **No safeguard against running on a row that's already past 'uploaded'.** If the prompt fail happens AFTER save-transcript succeeded but BEFORE save-summary (which sets state='transcribed'), the row has `state='transcribing'` with a valid transcript. onFailure clobbers it to `state='failed'`. The transcript is preserved in the column but the UI badge shows "Failed" — the teacher thinks they have nothing.

**Suggested fix.**
1. Snapshot the prompt body — not just the id — onto the discussion at finalize time. Add `discussions.transcription_prompt_body text`, `discussions.summary_prompt_body text`. The Inngest worker reads these from the row, not from the live prompts table. Admins editing the prompt cannot change what already-pending transcriptions use.
2. Alternative cheaper fix: version prompts. Add `prompts.version int` (or use the existing pattern of bumping `updated_at`). On edit, INSERT a new row + flip `is_default`. Discussions reference the immutable historical row by id; `body` never changes once committed.
3. onFailure handler should check the current state before clobbering: only clobber `state IN ('uploaded','transcribing')`. If the row is at `'transcribed'` or `'posted_to_super_grader'`, leave it alone — those are happy terminal states regardless of which downstream step the failure came from.

---

### C3 — `state='transcribing'` UPDATE has no state fence → two parallel job runs race the same discussion, double-billing Gemini and double-overwriting transcript

**Files:**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:73-90` — `load-discussion` reads the row (state included), then a synchronous `if (discussion.state !== "uploaded") return { skipped: true }` check.
- `apps/web/src/lib/inngest/transcribe-discussion.ts:112-118` — `mark-transcribing` step does `UPDATE discussions SET state='transcribing', error_message=null WHERE id = $1`. **No `.eq("state", "uploaded")` fence.**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:218-227` — `save-transcript` UPDATE: no state fence.
- `apps/web/src/lib/inngest/transcribe-discussion.ts:259-269` — `save-summary` UPDATE (which sets `state='transcribed'`): no state fence.
- `apps/web/src/lib/peers/notify.ts:181-199` — `pushDiscussionToSuperGrader` UPDATE setting `state='posted_to_super_grader'`: no state fence.
- `apps/web/src/lib/actions/upload-discussion.ts:152-156` — `inngest.send` wrapped in try/catch that silently swallows errors (C8). Combined with retries in finalizeDiscussion (e.g., user refresh after a transient finalize error before the action returned), one discussion can have multiple `discussion.uploaded` events queued.

**Root cause:** No state fence (#2) + no idempotency (#5).

**Failure scenario A — Inngest "Re-run" button.**
1. An operator (the user, in dev mode) clicks "Re-run" on a successful function run in the Inngest dashboard. Inngest typically fires the function with the original event but a new run ID.
2. The function starts. load-discussion reads the row. The row is now at `state='transcribed'` or `'posted_to_super_grader'`. The check at line 85-90 returns `{ skipped: true }`. **OK in this path.** Good.

**Failure scenario B — duplicate Inngest event from retried finalize.**
1. Teacher clicks "Upload recording". finalizeDiscussion runs, inserts the row, calls `inngest.send`. The send succeeds but the Vercel function timeout fires before the action's response reaches the browser. The browser shows a stalled spinner.
2. Teacher refreshes and clicks Upload again. `prepareDiscussionUpload` runs — dedup query at `prepare-discussion-upload.ts:42-49` finds the row from attempt #1 → returns "A recording is already linked..." error. Teacher confused but stops. **This dedup catches duplicate finalize from the same human.** OK.

**Failure scenario C — Inngest at-least-once delivery firing the function twice.**
1. Inngest's delivery semantics are at-least-once. In rare network/scheduler conditions, the same event triggers two function invocations near-simultaneously. The Inngest SDK doesn't dedupe across runs by default (per-step memoization is per-run, not cross-run).
2. Invocation A and B both call load-discussion. Both read `state='uploaded'`. Both pass the check at line 85.
3. Both call mark-transcribing — both flip `state` (the second is a no-op write but doesn't notice). Both call check-rate-limit → **TWO Gemini calls counted against the cap** when only one was authorized.
4. Both load-prompts-and-roster. Both call gemini-transcribe → **TWO uploads to Gemini Files API → TWO transcription generateContent calls → DOUBLE Gemini bill (~$0.22 instead of $0.11 per discussion)**.
5. Both write transcript via save-transcript. Last write wins; the two transcripts will differ in non-trivial ways (Gemini is stochastic) — teacher sees a stable transcript that's the loser of a race they don't know happened.
6. Both fire push-to-super-grader. SG sees TWO POSTs per participant. SG's per-`peer_results` upsert should dedupe by key, but the `completed_at` (= `updated_at` per envelope) and `super_grader_response` jsonb differ between the two runs.

**Failure scenario D — delete-mid-transcription state stomp (worst case).**
1. Recording uploaded, state='uploaded'. Inngest worker starts.
2. mark-transcribing succeeds → state='transcribing'. The worker proceeds with gemini-transcribe (~30s).
3. Teacher hits Delete on the dashboard while the audio still plays. deleteDiscussion runs the row delete (cascade kills participations) + best-effort storage remove.
4. Inngest worker reaches save-transcript: `UPDATE discussions SET transcript=... WHERE id=$1`. **Zero rows affected.** No error raised by the Supabase SDK on 0-rows-affected for an UPDATE. **The step thinks it succeeded.**
5. Worker continues to gemini-summarize — burns another Gemini call against the now-deleted discussion. save-summary: another 0-rows-affected silent success. push-to-super-grader: envelope build returns null (no discussion row → `buildHarknessEnvelopeForCanvasIds` returns null at `envelope.ts:39`) → each per-participant attempt records `"envelope build returned null"` → status='error' UPDATE: 0 rows affected → silent.
6. Net: ~$0.11–0.22 Gemini billing on a discussion that doesn't exist. Inngest run shows green / success. No log says anything weird happened.

**Suggested fix.**
1. **State-fenced UPDATEs throughout the function:**
   ```ts
   const { data, error } = await admin
     .from("discussions")
     .update({ state: "transcribing", error_message: null })
     .eq("id", discussionId)
     .eq("state", "uploaded")
     .select("id");
   if (error) throw new Error(`mark transcribing: ${error.message}`);
   if (!data || data.length === 0) {
     // already advanced by a sibling run — skip the whole pipeline
     return { skipped: true, reason: "state advanced concurrently" };
   }
   ```
   Apply the same `.eq("state", expected)` + 0-row-affected detection at save-transcript (expected='transcribing'), save-summary (expected='transcribing'), and pushDiscussionToSuperGrader's final UPDATE (expected='transcribed').
2. **Detect 0-rows-affected after every UPDATE.** Treat as "discussion was deleted or state advanced" and abort the pipeline gracefully (no more Gemini calls, no more SG pushes). Today the SDK swallows this case silently.
3. **Use a deletion tombstone** instead of hard delete: `discussions.deleted_at timestamptz`. Workers check `deleted_at IS NULL` in every fence. The deleteDiscussion action sets `deleted_at = now()` and the row stays until a sweeper hard-deletes after the in-flight worker has had time to abort. Audio file can be deleted immediately, but the worker checks `deleted_at` BEFORE making any Gemini call.
4. **Application-level event dedup.** Persist a hash of `discussionId` to a `processed_events` table inside an Inngest step at the top of the function with `INSERT ... ON CONFLICT DO NOTHING ... RETURNING id`; if the insert collided, this is a duplicate event — abort.

---

### C4 — Roster lookup failure (Postgres error vs missing row) is handled fail-closed in one branch, fail-open in another → inconsistent privacy posture

**Files:**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:125-131` — `rosterErr` (Postgres-level error) → throws → job fails. Good.
- `apps/web/src/lib/inngest/transcribe-discussion.ts:132-143` — missing row (rosterRow is null) → silently falls through with empty roster. Bad (per C1).
- `apps/web/src/lib/actions/upload-discussion.ts:66-78` — finalizeDiscussion: same split. `rosterErr` returns ok:false (good). Missing row gives empty roster → falls through to insert discussion → fires Inngest event with an empty roster downstream.

**Root cause:** Fail-open (#4). The PG-error path correctly fails closed; the missing-row path silently passes through. Two completely different privacy postures for what should be a single "I can't anonymize without a roster" rule.

**Suggested fix.**
1. Treat null rosterRow as a hard fail in both files. Even better: require a non-empty `students` array; a zero-length roster row is also a fail.
2. Surface a UI error path in finalizeDiscussion: "Roster for this course is empty. Sync your courses on the dashboard before recording, or the transcript cannot be anonymized."
3. Per the dual root cause with C1, the snapshot column would address this — finalizeDiscussion would snapshot a frozen roster onto the discussion row, OR it would fail. The Inngest worker would simply read the snapshot — no fail-open path possible because the column is NOT NULL.

---

### C5 — onFailure handler can clobber successful terminal states (`'transcribed'`, `'posted_to_super_grader'`)

**Files:**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:54-67` — onFailure handler. Unconditional `UPDATE discussions SET state='failed', error_message=... WHERE id=$1`. **No state fence.**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:1-11` — code comment claims this is safe because `pushDiscussionToSuperGrader` "never throws". That claim relies on the entire `notify.ts` function's internal try/catch — but any thrown exception OUTSIDE that try (a TypeError on `process.env.NEXT_PUBLIC_APP_URL.replace(...)` if APP_URL becomes undefined mid-run, a Promise.all rejection if one of the parallel attempt-builders throws before reaching its own try, an OOM crash from a giant transcript, the Vercel platform timing the function out at 300s) propagates out of `step.run("push-to-super-grader", ...)`. Inngest retries 2x then onFailure runs.

**Failure scenario.**
1. save-summary succeeds. discussions row: state='transcribed', summary populated, transcript populated. Happy.
2. push-to-super-grader step starts. Inside `pushDiscussionToSuperGrader`, a participant's envelope build throws a Postgres error (Supabase pooler hiccup). The try/catch at `notify.ts:157-163` returns `ok:false`. OK.
3. **But:** the OUTER UPDATE at `notify.ts:199` (`await admin.from("discussions").update(update).eq("id", discussionId)`) has no try/catch. If THIS UPDATE throws (different Postgres error class — e.g., connection lost mid-statement), the throw bubbles up out of `pushDiscussionToSuperGrader`, out of `step.run`, into the Inngest runtime. The step is marked failed.
4. Inngest retries 2x (each retry re-runs `pushDiscussionToSuperGrader` — see C6 for the double-push problem). Eventually exhausted.
5. onFailure handler fires: `UPDATE discussions SET state='failed', error_message='...' WHERE id=<discussionId>`. **Row was at state='transcribed' (happy). Now it's at state='failed'.** Teacher's dashboard suddenly shows the discussion as "Failed" with a confusing error message, even though both the transcript and the summary are in the DB and visible to Save-to-Drive (which works off the column contents).
6. Even worse: if `pushDiscussionToSuperGrader` had partially succeeded and the inner UPDATE wrote `state='posted_to_super_grader'` before throwing on something else, the row went `transcribed → posted_to_super_grader → failed`. The transition graph is broken.

**Root cause:** No state fence on the onFailure UPDATE (#2). The protective claim in the code comment is fragile.

**Suggested fix.**
1. Fence the onFailure UPDATE: `.eq("id", discussionId).in("state", ["uploaded", "transcribing"])`. Never clobber a terminal state. If the row is already at `'transcribed'` or `'posted_to_super_grader'`, leave it alone — that's a partial-success state that should stay surfaced as the success it represents.
2. Wrap the inner UPDATE in `pushDiscussionToSuperGrader` (notify.ts:199) in try/catch + log. Even on inner UPDATE failure, the function should return its `PushOutcome` rather than throwing — preserving the claimed "never throws" contract.
3. Add a regression test that runs the worker against a row at state='transcribed' and asserts onFailure does NOT downgrade it.

---

## HIGH

### H1 — `prepareDiscussionUpload` dedup race + signed-URL upsert lets two clients overwrite each other's audio for the same (assignment, section)

**Files:**
- `apps/web/src/lib/actions/prepare-discussion-upload.ts:42-57` — dedup is a SELECT-then-act with no lock. Two concurrent clients both see no existing row, both get a signed upload URL.
- `apps/web/src/lib/actions/prepare-discussion-upload.ts:59-71` — storage path is deterministic: `${teacher.id}/${canvasAssignmentId}/${sectionSlug}/recording.${ext}`. **Same path for both concurrent clients.** Signed URL issued with `upsert: true`.
- `apps/web/src/app/dashboard/RecordingFlow.tsx:72-88` — client PUTs directly with `x-upsert: true`.
- `apps/web/src/lib/actions/upload-discussion.ts:82-102` — finalizeDiscussion INSERTs the discussion row. The composite unique constraint (`canvas_assignment_id`, `canvas_section_id`) NULLS NOT DISTINCT (per `20260516140000_discussion_per_section.sql:19-21`) catches the second insert → returns ok:false. **But by then the storage object is already overwritten.**

**Root cause:** No idempotency / no atomic-start (#5) + no transactional boundary (#3) between storage upload and DB insert.

**Failure scenario A — teacher opens dashboard in two tabs and uploads from each.**
1. Tab A and Tab B both have the same recording loaded (or different recordings — doesn't matter).
2. Both click Upload near-simultaneously. Both call `prepareDiscussionUpload` → both pass dedup → both get signed URLs for the SAME storage path with `upsert: true`.
3. Both PUT. Whichever PUT finishes last wins — bytes are deterministic by last-write.
4. Both call `finalizeDiscussion`. First one INSERTs the row. Second one's INSERT throws unique-violation → ok:false → tab B shows "discussion insert: duplicate key value violates unique constraint discussions_assignment_section_unique".
5. **The row's audio bytes may be from the LOSER tab, not the winner.** Tab A's user sees "Uploaded. Transcription is queued." but the audio in storage is Tab B's. Inngest transcribes Tab B's audio. The user opening the recording later in the dashboard plays back the wrong session.

**Failure scenario B — re-upload after delete during in-flight playback.**
1. Discussion exists, audio in storage. Teacher deletes (`deleteDiscussion` runs — row gone, storage best-effort removed). Then immediately uploads a new recording (same assignment + section).
2. New `prepareDiscussionUpload`: no row, dedup passes. Same deterministic path. PUT overwrites whatever stale bytes might still be there (if the storage delete in deleteDiscussion failed silently per `delete-discussion.ts:40-43`).
3. **Meanwhile**, the original discussion's Inngest worker may STILL be in flight (delete-mid-transcription per C3-D). Its `audio_url` field pointed at the same storage path. The worker downloads the NEW recording, transcribes the wrong audio against the deleted discussion's already-orphan id. Wasted Gemini call, but more importantly the new discussion's worker (when it fires) ALSO transcribes — both pipelines transcribe the same bytes.

**Suggested fix.**
1. Insert the discussion row BEFORE issuing the upload URL. Make `prepareDiscussionUpload` insert state='preparing' (a new state) with `audio_url=NULL`, then issue the signed URL with the discussion id encoded in the path: `${teacher.id}/${discussionId}/recording.${ext}`. The composite unique constraint catches the race at insert time, BEFORE bytes move. The losing client gets a clean error and doesn't waste an upload.
2. Alternative: drop `upsert: true`. A `409 Conflict` on the PUT is the right signal that "this slot is taken" — much better than silent overwrite.
3. Storage path should NOT collide between sequential uploads of the same (assignment, section). Use a content-addressed name or include `recorded_at + uuid`. The current deterministic path means a delete-then-re-upload sequence is indistinguishable from an overwrite, breaking any reasoning about "is this the same audio?".

---

### H2 — `inngest.send` failure in finalize is silently swallowed → discussion stuck at `state='uploaded'` forever with no UI cue

**Files:**
- `apps/web/src/lib/actions/upload-discussion.ts:152-159` — `try { await inngest.send(...) } catch { /* swallow */ }`. The comment says "Don't block the upload's success on a missing Inngest dev server" — but the same swallow is in prod where the event key/signing key may be misconfigured or Inngest cloud may be temporarily unreachable.
- `apps/web/src/app/dashboard/DiscussionList.tsx:64-75` — dashboard polls every 5s while any row is `'uploaded'` or `'transcribing'`. A row stuck at `'uploaded'` polls forever; the UI shows "Awaiting transcription" indefinitely with no way to retry except deleting and re-recording.

**Root cause:** Fail-open (#4) + no retry/idempotency (#5).

**Failure scenario A — Inngest stale registration after Vercel rename.**
- Per the suite memo in MEMORY.md and the HH-local CLAUDE.md gotcha section: a Vercel rename leaves Inngest cloud POSTing to the OLD URL. `inngest.send()` returns 200 (event reached Inngest cloud). Function never fires.
- Discussion sits at `'uploaded'` indefinitely. UI shows the polling spinner ("Awaiting transcription"). Browser tab eats CPU on infinite poll. Teacher gives up after 5 minutes and re-records, which they CAN'T because the dedup check blocks them (the row still exists at state='uploaded').
- Fix the operator-side (`curl -X PUT https://harkness-helper-v2-sgs.vercel.app/api/inngest` per memo), but the code-side: no detection, no retry, no admin button to re-send the event for stuck rows.

**Failure scenario B — Inngest event key misconfigured or rotated.**
- `process.env.INNGEST_EVENT_KEY` is wrong or expired. `inngest.send()` throws inside the try. Caught and swallowed. finalizeDiscussion returns ok:true. **Row exists. No Inngest event was sent. No log.**
- Without log analysis the teacher cannot tell the difference between "transcription is slow" and "transcription was never queued".

**Suggested fix.**
1. Don't swallow the send error. Log it; if INNGEST_DEV is unset and we're in production, treat as ok:false → return an error to the client.
2. Local-only swallow: gate the swallow on `process.env.INNGEST_DEV === "1"`. Anywhere else, propagate.
3. Add a per-row "stuck-detection" sweeper: a daily Inngest function (or cron) that scans for `discussions WHERE state='uploaded' AND created_at < now() - interval '1 hour'` and either re-sends the event or marks the row 'failed' with a "queue lost" message.
4. Add a manual "Retry transcription" admin button on each discussion row that re-fires the `discussion.uploaded` event.

---

### H3 — Inngest step retry re-fires per-student super-grader POSTs → SG sees N×retries duplicate webhooks per discussion

**Files:**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:276-278` — `push-to-super-grader` step wraps `pushDiscussionToSuperGrader(discussionId)` as a single step.
- `apps/web/src/lib/peers/notify.ts:116-166` — inside `pushDiscussionToSuperGrader`, the fan-out is a `Promise.all` over per-student fetches. Each per-attempt try/catch returns `ok:false` instead of throwing → the Promise.all resolves → no throw → the step's body returns the `PushOutcome` normally.
- BUT: if the very last UPDATE at `notify.ts:199` throws (e.g., transient Postgres error), the step throws, Inngest retries the step, retry calls `pushDiscussionToSuperGrader(discussionId)` AGAIN, which fans out ALL N POSTs AGAIN. Same for the load-discussion `.single()` at line 64 throwing on a flaky pool.

**Root cause:** No retry/idempotency on user-visible mutations (#5). The step is not idempotent because it makes external HTTP POSTs with no per-target dedup.

**Failure scenario.**
1. Discussion has 10 participants. push-to-super-grader step starts. All 10 fetch-builds + POSTs run in parallel. 10 SG `peer_results` upserts land — done. PushOutcome is built.
2. The trailing UPDATE at notify.ts:199 hits a pool-disconnect (Supabase rolling restart). Throws.
3. Inngest sees the step failed → retries. push-to-super-grader runs again. All 10 POSTs fire AGAIN. SG sees 20 inbound webhooks instead of 10.
4. SG's peer_results upsert keyed on `(peer, canvas_user_id, canvas_assignment_id)` deduplicates → no extra rows. But:
   - SG audit log (if any) shows 20 inbound events.
   - SG's `completed_at` jitters between the two attempts (transcribe-discussion's `updated_at` may have ticked between the two runs because notify.ts wrote diagnostic fields).
   - **Each POST is metered against SG's inbound rate limits.** If SG has rate-limiting on `/api/ingest/harkness`, the second batch may be throttled, causing some students to land in `failed`.

**Failure scenario B — load-discussion at notify.ts:64 throws.**
- The function's first thing is `await admin.from("discussions").select(...).single()`. If THIS throws (e.g., row was concurrently deleted, or pool error), it goes into the catch at line 94. The catch returns a PushOutcome with `failed=[("(load)", message)]` — the function doesn't throw. The step succeeds. Good in this branch.

- But: imagine a future code change that moves the participants query before the discussion query, or changes the error handling. The current code is one refactor away from a real double-fire.

**Failure scenario C — partial in-flight before timeout.**
- Vercel's serverless function timeout is 300s (paid plan). If `pushDiscussionToSuperGrader` is mid-Promise.all when the timeout fires, only some students' POSTs have landed. The step is marked failed (timeout = thrown error from outside the function). Retry replays from the top → fans out ALL students again. **Successfully-posted students get a second POST.** No per-student idempotency token, no per-student "already posted" tracking inside the function.

**Suggested fix.**
1. Split the fan-out into one Inngest step per student: `step.run(\`push-${cuid}\`, ...)`. Step-level memoization checkpoints each student's success individually; a retry only re-runs the ones that failed.
2. Add an idempotency key in the outbound POST: include a stable `discussionId + canvas_user_id` UUID in the envelope (or as an HTTP header), and SG's ingest dedupes on it for some window (e.g., 5 minutes).
3. Track per-participant push state on the participations table (`participations.posted_to_sg_at timestamptz`), so a retry knows which students to skip. Today the function has no per-student persistence — only a discussion-level `super_grader_post_status`.
4. Move the trailing diagnostic UPDATE into a separate `step.run("persist-push-status", ...)` so its failure doesn't re-trigger the fan-out.

---

### H4 — Roster `email`-required filter silently drops participants → discussion is created with fewer `participations` rows than the teacher selected

**Files:**
- `apps/web/src/lib/actions/upload-discussion.ts:105-148` — `studentRows` is built by mapping `participantIds` and dropping any roster student where `r.email` is falsy (line 108-109). `participantIds` may have 12 entries but `studentRows` ends up with 10 after the filter.
- `apps/web/src/lib/actions/upload-discussion.ts:135-148` — `participations` INSERT runs over the filtered list. No error. The 2 dropped students simply don't get a participation row — and the teacher's UI has no idea.
- `apps/web/src/app/dashboard/TargetPicker.tsx:18-22` — `RosterStudent.email` is typed as `string | null` (the section migration's roster jsonb shape doesn't force email). The UI doesn't currently visualize "this student lacks email and won't be tracked".

**Root cause:** Fail-open (#4). The cure for missing email is "drop the student" rather than "block the upload + tell the teacher".

**Failure scenario.**
1. Canvas roster sync ran with the new `/courses/:id/users?include[]=email` endpoint, but one student has email visibility restricted (per Canvas permissions — even the new endpoint can return `email: null` for some accounts depending on the teacher's role). Their roster jsonb entry is `{canvas_user_id: "12345", name: "Real Name", email: null, section_ids: [...]}`.
2. Teacher picks all 12 students for the discussion via the participant checklist (default-all). `participantIds` = 12 entries.
3. finalizeDiscussion drops the null-email student silently. 11 participation rows created. Inngest fires.
4. push-to-super-grader runs. Envelope built per `participations → students` join. Only 11 students get a Harkness `peer_results` row in super-grader. **The 12th student's Harkness participation never registers anywhere.** Teacher thinks all 12 are tracked.
5. If the 12th student is the one whose name leaked into the transcript (because they're not in the scrubbed roster either — see C1), they get a double-bleed: real name in DB + no peer_results row that would attribute the discussion participation correctly.

**Suggested fix.**
1. Block the upload if any selected participant lacks email. Return a clear ok:false: "Cannot anonymize without email for {N students}. Re-sync your roster (some students' email may be hidden in Canvas — check that you have the right permission scope)."
2. UI: render missing-email students with a warning badge in the participant picker. Teacher can choose to deselect or fix.
3. Log the silent drop today so it shows up in production logs at least.

---

### H5 — `delete-mid-transcription` race: storage gone but worker still calls Gemini and writes summary to a now-orphan row (0-rows-affected silent)

**Files:**
- `apps/web/src/lib/actions/delete-discussion.ts:32-43` — deletes the row first (DB cascade kills participations), then best-effort storage remove. The audio file is removed AFTER the row.
- `apps/web/src/lib/inngest/transcribe-discussion.ts:154-210` — gemini-transcribe step. Reads `discussion.audio_url` from the in-memory `ctx` (loaded once at job start). Doesn't re-read the row.
- `apps/web/src/lib/inngest/transcribe-discussion.ts:218-227, 259-269` — both UPDATE without checking if the row still exists. PostgREST silently returns 0-rows-affected on missing row; no error.
- `apps/web/src/lib/inngest/transcribe-discussion.ts:94-109` — rate-limit RPC runs even for the deleted discussion. **Teacher's daily cap decremented for a discussion they killed.**

**Root cause:** No state fence / no liveness check (#2) + no transactional boundary across DB delete + in-flight Inngest function (#3).

**Failure scenario A — delete after gemini-transcribe checkpoint.**
1. Worker is running. mark-transcribing succeeded. check-rate-limit incremented the cap. gemini-transcribe completed; transcript is in memory (Inngest checkpointed step result).
2. Teacher deletes the discussion. Row gone. Storage file gone.
3. Worker proceeds to save-transcript: `UPDATE ... WHERE id=$1`. Postgres: 0 rows affected, no error. Step returns void → success.
4. Worker proceeds to gemini-summarize → ANOTHER Gemini call ($0.05–0.11). Step returns the summary text.
5. save-summary: 0 rows affected. push-to-super-grader: load-discussion via `.single()` throws on 0 rows → caught at notify.ts:94-114 → returns PushOutcome with `failed=[("(load)", ...)]`. The trailing UPDATE at notify.ts:199 also 0-rows-affected silent.
6. The function returns success to Inngest. The deleted discussion never existed, but billions of clock cycles + Gemini dollars were spent on it. **No log surfaces the waste.**

**Failure scenario B — delete during gemini-transcribe (file 404).**
1. Worker is mid-Gemini Files API poll loop (file uploaded to Gemini, ACTIVE polling, generateContent call inbound).
2. Teacher deletes. Row gone, storage file gone.
3. The Gemini call proceeds anyway because the file is already uploaded to Google's side. The transcript text comes back successfully.
4. Same as scenario A from this point — silent waste.

Worse: the SIGNED URL generation at line 158-163 (within the step) succeeds even after the storage object is deleted (the URL is just a presigned URL; whether the underlying object exists is checked at fetch time). The audio download at line 164-168 (`fetch(signed.signedUrl)`) returns 404 (or 400). **In that path, gemini-transcribe throws → retries 2x → onFailure marks state='failed'**. UPDATE on a deleted row: 0-rows-affected silent. Function effectively completes with state='failed' applied to nothing. Inngest dashboard shows 3 failed runs.

**Suggested fix.**
1. **Soft-delete tombstone.** Replace hard delete with `UPDATE discussions SET deleted_at = now() WHERE id = $1 AND teacher_id = $teacher`. Workers check `deleted_at IS NULL` (via a state fence: `.is("deleted_at", null)`) before any Gemini call. After a sweep window (e.g., 1 hour) a sweeper hard-deletes tombstoned rows and orphan storage.
2. **Verify the row exists at every persistence step.** Use `.eq("state", "transcribing").select("id")` + check returned rows. 0 rows → abort the rest of the pipeline.
3. **Audio file path includes discussion id** (see H1 suggestion). When the worker tries to sign a URL for a path that doesn't exist, fail fast and abort.

---

### H6 — `state='posted_to_super_grader'` flip is all-or-nothing, but the per-student fan-out is best-effort → 9/10 success leaves the state stuck at `'transcribed'` forever

**Files:**
- `apps/web/src/lib/peers/notify.ts:180-199` — `allOk = failed.length === 0 && postedFor.length > 0`. If even one participant's POST fails, `allOk` is false → state stays at `'transcribed'`, `super_grader_post_status = 'error'`.
- No retry surface anywhere: the per-discussion `super_grader_post_status` and `super_grader_response` jsonb persist the failure diagnostics, but nothing in the codebase ever re-fires the push for stuck-at-error rows.

**Root cause:** No retry/idempotency (#5) + no per-student state granularity. A single transient SG flake on one student's POST locks the entire discussion out of the `'posted_to_super_grader'` terminal state forever.

**Failure scenario.**
1. Discussion has 10 participants. push-to-super-grader runs. 9 POSTs succeed. 1 POST gets a 503 from SG (transient).
2. `failed.length === 1`, `allOk` is false. UPDATE writes `super_grader_post_status='error'`, `super_grader_response.failed = [{cuid: "X", status: 503, ...}]`. **state stays at `'transcribed'`.**
3. UI dashboard chip shows "Transcribed" not "Posted to super-grader". The badge color is emerald instead of violet. Subtle but visible.
4. **There's no retry path.** The teacher cannot click "Retry push" for the failed student. The 9-of-10 partial success persists forever. From the teacher's POV, they don't know whether SG has 9 or 0 of the participants.
5. If SG is back up an hour later, nothing in HH automatically reattempts. The data drift between HH and SG persists indefinitely.

**Suggested fix.**
1. Per-student state column on `participations`: `posted_to_sg_at timestamptz null`, `last_push_attempt_at timestamptz null`, `last_push_error text null`. Push step writes these per-student.
2. A sweeper Inngest function (`retry-stuck-sg-pushes`) that runs every 5 minutes against participations with `posted_to_sg_at IS NULL` and `last_push_attempt_at < now() - interval '1 minute'`. Caps retries (e.g., 5) before surfacing a UI error.
3. Compute discussion-level `state='posted_to_super_grader'` from `EVERY participation row posted` (or a counter column). Today the discussion-level state is set in lockstep with all-success; partial-success has no representation.

---

### H7 — Polling-refresh regenerates audio signed URLs every 5s on `<audio>` rerender → in-flight playback gets interrupted

**Files:**
- `apps/web/src/app/dashboard/page.tsx:107-115,116-127` — server-side, every page load (including `router.refresh()`) regenerates a NEW signed URL with 1hr TTL.
- `apps/web/src/app/dashboard/DiscussionList.tsx:71-75` — `setInterval(() => router.refresh(), POLL_INTERVAL_MS)` while any row is non-terminal.
- `apps/web/src/app/dashboard/DiscussionList.tsx:209-216` — `<audio src={d.audio_signed_url}>`. Every poll → new src URL → React re-mounts the element → playback restarts.

**Root cause:** Acknowledged in CLAUDE.md ("`router.refresh()` polling regenerates signed URLs"). UX bug.

**Failure scenario.** Teacher records a 50-min Harkness discussion; uploads. The discussion is `'uploaded'` then `'transcribing'`. Teacher wants to listen back while transcription runs. They press play on the audio element. 5s later, polling refreshes. The audio element's src changes (new signed URL with a different signature query param). Browser sees src change → tears down playback → starts over from second 0. Repeats every 5s. Teacher can never get past second 5.

**Suggested fix.**
1. Memoize signed URLs in the client (sessionStorage or in-memory) keyed on `discussionId + storage path`. Only re-fetch when the URL is near expiry.
2. Server: don't regenerate the signed URL on every refresh; cache it (or include a stable `?v=audio_url` query param hash so the URL is byte-identical across refreshes).
3. Better: pass the storage path to the client and have the client fetch the signed URL once via a tiny `/api/discussions/:id/audio-url` endpoint; cache aggressively in the client.

---

### H8 — Best-effort storage delete in deleteDiscussion swallows errors → orphan storage objects accumulate forever

**Files:**
- `apps/web/src/lib/actions/delete-discussion.ts:40-43` — `.catch(() => {})` on the storage remove call. If the storage delete fails (network blip, S3 transient error, the path doesn't exist because of a previous race), no log, no retry, no DB marker.
- `apps/web/src/lib/actions/delete-discussion.ts:1-47` — there's no sweeper to find orphan storage files. The bucket size grows monotonically with every delete-failure.
- `supabase/migrations/20260516120000_discussion_audio_bucket.sql` — bucket is private with no policies; there's no Storage RLS path that surfaces orphan listings.

**Root cause:** Fail-open (#4). The comment says "we'd rather have an orphan file than a phantom row" — fine direction, wrong execution: there's no record kept that an orphan was created.

**Failure scenario.**
1. Storage backend has a 30s blip. Teacher deletes 5 discussions in that window. Row deletes all succeed; storage removes all silently fail. 5 orphan audio files persist.
2. Bucket size grows. Supabase storage costs tick up. No alert.
3. Audit-wise: nothing in DB references those orphan files. Privacy concern: the audio is still indexable via signed-URL forgery (only if someone has the salt) — but more importantly, the teacher believes those recordings are gone.

**Suggested fix.**
1. Persist a "deletion failure" log to a small DB table: on storage remove failure, INSERT `pending_storage_deletions(storage_path, attempted_at, error_message)` rows. A sweeper retries.
2. Or: weekly Inngest cron that lists the bucket, joins against active `discussions.audio_url` (or `pending_storage_deletions`), and removes anything not referenced AND older than 24h.
3. Surface storage delete failures in the action's return value as a soft warning: "discussion deleted; audio file cleanup pending — will be retried in background".

---

### H9 — Inngest stale registration after Vercel rename is undefended in code (operational risk, but no in-code mitigation)

**Files:**
- `apps/web/src/app/api/inngest/route.ts:1-14` — vanilla `serve()` wrapper. No post-deploy registration refresh, no healthcheck.
- HH CLAUDE.md + suite memory note: confirmed pattern is "PUT /api/inngest after any rename".

**Failure scenario.** Vercel rename happens (e.g., the project gets recreated as a fix for some unrelated issue). Inngest cloud keeps POSTing to the old URL silently. Symptom: `discussion.uploaded` events return 200 from `inngest.send` (event landed in Inngest cloud) but the function never fires. Discussions sit at `'uploaded'` forever with the dashboard spinner running.

This is the same pattern as HAH H8; the fix is the same:
1. Add a `postdeploy` hook in `vercel.json` (or via a Vercel deploy hook) that PUTs `/api/inngest`.
2. Or: small admin button that PUTs `/api/inngest` for one-click refresh.
3. Or: a healthcheck route exercising a no-op Inngest function on every dashboard page-load — but this is too aggressive for a production app.

---

### H10 — `pushDiscussionToSuperGrader` re-loads discussion + participations live at push time, not from the orchestrator context → race with delete and with concurrent edits

**Files:**
- `apps/web/src/lib/peers/notify.ts:60-93` — `pushDiscussionToSuperGrader` re-loads the discussion and the participations from scratch. The discussionId is the only input.
- `apps/web/src/lib/inngest/transcribe-discussion.ts:73-83` — the orchestrator has a fully-loaded `discussion` ctx but doesn't pass it through to the push step. Push step re-queries.
- `apps/web/src/lib/peers/envelope.ts:30-69` — inside envelope build, ANOTHER live query reads `discussions` and `participations`.

**Root cause:** No snapshot semantics (#1). Each step's external interactions read live state and risk seeing post-delete/post-edit shapes.

**Failure scenario.**
1. save-summary just ran successfully. state='transcribed'. push-to-super-grader step is about to start.
2. In the ~10ms before push-to-super-grader's first SELECT, the teacher deletes the discussion. Row gone. Participations gone (cascade).
3. push step's first query at `notify.ts:62-68`: `.single()` on a deleted row → throws "no row" → caught at line 94 → PushOutcome.failed = [("(load)", "no rows returned")] → status='error' → state stays at 'transcribed' (well — UPDATE on a deleted row is silent no-op; state field stays whatever it was, but the row doesn't exist).
4. Or: row still exists but participations were edited (a teacher used a future admin tool to remove a student from a discussion). The push step doesn't see what the orchestrator saw.

**Suggested fix.** Pass the loaded data into the push step:
```ts
const pushOutcome = await step.run("push-to-super-grader", async () => {
  return pushDiscussionToSuperGrader({
    discussionId,
    canvasAssignmentId: discussion.canvas_assignment_id,
    participants: snapshot_participants, // loaded once at top of function
  });
});
```
This also avoids hitting Postgres redundantly (4+ queries deep in notify.ts → envelope.ts).

---

## MEDIUM

### M1 — `discussions.audio_url` has no schema-level shape check; storage path drift is undetected

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:79` — `audio_url text not null`. No CHECK on shape.
- `apps/web/src/lib/actions/prepare-discussion-upload.ts:60-61` — path constructed as `${teacher.id}/${canvasAssignmentId}/${sectionSlug}/recording.${ext}`.

If the path format ever changes (e.g., a future migration changes to `${discussionId}/...`), already-stored rows still hold old-format paths. There's no field telling you which format the row uses; `audio_url` is opaque.

**Suggested fix.** Add `audio_path_version int` or include the schema in the path (e.g., `v2/${discussionId}/...`). Document the change in the migration that introduces a new shape.

---

### M2 — `discussions.canvas_section_id` has no DB-level CHECK that it matches one of the sections in the joined `course_rosters.sections` jsonb

**Files:**
- `supabase/migrations/20260516140000_discussion_per_section.sql:14` — `add column canvas_section_id text` (nullable, plain text, no FK).
- `apps/web/src/lib/actions/upload-discussion.ts:23-26,86-90` — trims and inserts the raw string.

If the client tampers with section id (or sends a stale one after a roster re-sync renamed sections), the row is inserted with a section id that doesn't exist anywhere. Dashboard's `sectionLabelById[d.canvas_section_id]` returns undefined → renders nothing in the section slot. The section is permanently "phantom" on that row.

**Suggested fix.**
1. Validate `canvasSectionId` against the course's `course_rosters.sections` jsonb in finalizeDiscussion. Reject if no match (and section_ids isn't an empty array).
2. Long-term: normalize sections into a `course_sections` table with FK constraint on `discussions.canvas_section_id`.

---

### M3 — Recorder's wake-lock state vs. component-unmount race can leave a held wake lock or drop the audio blob

**Files:**
- `apps/web/src/app/dashboard/Recorder.tsx:50-56` — cleanup effect releases wakelock + stops tracks on unmount.
- `apps/web/src/app/dashboard/Recorder.tsx:140-152` — `recorder.onstop` fires asynchronously. If the component unmounts mid-recording (navigation away, parent re-renders with new key — note `RecordingFlow.tsx:124,131` uses `key={\`recorder-${resetCounter}\`}` which re-mounts the Recorder), the cleanup at line 53 stops the stream's tracks. `recorder.onstop` may or may not fire depending on browser implementation (Safari and Chrome differ).
- If `recorder.onstop` doesn't fire, `onAudioReady` never fires, the recorded blob is lost. The wake lock IS released. Minor data loss.

**Failure scenario.** Teacher records, hits Stop, the Recorder switches to "stopped" state with a playable preview. Then they hit a back button or navigate away. The blob is in memory (already captured by `onAudioReady` because that callback fired in the recorder.onstop handler before unmount). OK in this path.

But: if they record, the page tab freezes (memory pressure), the OS kills the tab — wake lock is held. No release path. Minor.

**Suggested fix.**
1. Explicit "Are you sure?" guard on navigation while state='recording'.
2. Move the audio blob capture to a more durable layer (e.g., IndexedDB) so it survives a page navigation.

---

### M4 — Re-record loop: `Recorder.reset()` doesn't actually stop the underlying MediaStream tracks immediately

**Files:**
- `apps/web/src/app/dashboard/Recorder.tsx:190-200` — `reset()` clears UI state but doesn't call `streamRef.current?.getTracks().forEach((t) => t.stop())`. The stream is implicitly stopped by `recorder.onstop` at line 145, but only if the recorder was actually running. Calling reset from `state='idle'` (or right after re-record) leaves the previous stream alive momentarily.

Minor — eventually GC'd, but the mic indicator may stay on visibly for an extra moment in some browsers.

**Suggested fix.** Explicitly stop the stream in `reset()`.

---

### M5 — `discussions.error_message` is freeform text with no length cap at the DB level

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:85` — `error_message text` (no size limit).
- `apps/web/src/lib/inngest/transcribe-discussion.ts:64` — slices to 1000 chars at the onFailure handler. OK in that one path.
- `apps/web/src/lib/peers/notify.ts:99-114` — error message in `super_grader_response` jsonb is not sliced.

A pathologically long error message (e.g., Gemini returning a 100KB error body) lands in the row. Dashboard tries to render it via the `title={d.error_message}` attribute → browser truncates the tooltip but the row payload is still large. Combined with the discussions.summary text (also unbounded), a single row can be a multi-MB blob.

**Suggested fix.** DB CHECK `length(error_message) <= 2000`. Slice at every write site that goes near `error_message` or `super_grader_response`. Reasonable upper bound on summary (e.g., 50KB) too — the v1 prompt says aim for 400-800 words, ~4KB; 50KB is 12x that.

---

### M6 — `participations_self_select` policy doesn't gate `students` join → admin overlay policy is correctly permissive but teacher-self policy on `students` skips section-mate visibility

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:163-170` — `participations_self_select` checks `is_teacher_owner(d.teacher_id)` via subquery.
- `supabase/migrations/20260513120000_initial_schema.sql:157-158` — `students_self_select` checks `is_teacher_owner(teacher_id)`.

So a teacher's user-client can SELECT all their own participations and join to their own students. Cross-teacher leakage is correctly blocked. OK.

But: the dashboard page's main `discussions` SELECT runs as the user. The signed URL generation runs as admin. There's an inconsistency: the dashboard's polling at line 39-64 of page.tsx runs as the user (RLS-applied) but the audio URL on each row is then signed as admin and handed back to the same user. **The audio URL doesn't enforce a per-row teacher check** — the admin client signs whatever path is on the row. If a teacher-A's client somehow obtains a teacher-B's discussion id (e.g., via a future admin-debug surface that leaks ids), admin signs B's audio URL and hands it back to A.

This isn't currently exploitable (the discussions SELECT is RLS-fenced and teacher A's UI only sees teacher A's row ids), but the admin-signing-without-ownership-check is a latent vulnerability.

**Suggested fix.** In page.tsx's signed-URL generation loop, verify the row's teacher_id against the current teacher before signing. Better: just have the user-client request the signed URL via a server action that verifies ownership.

---

### M7 — `discussions` table has no INSERT/UPDATE/DELETE policy → user client can't write, but no explicit deny logged

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:147-170` — `alter table discussions enable row level security` but only a `discussions_self_select` policy exists. INSERT/UPDATE/DELETE have no policy.
- Per RLS semantics: enabled-but-no-policy = default deny. A user-client attempt to INSERT/UPDATE/DELETE returns 0 rows affected silently (or an error depending on operation).

This is the intended posture (all writes go through admin client), but it makes future bugs (a maintainer using the user client by mistake) silently fail. The admin overlay policies at `20260513120001_admins_and_prompts.sql:119-126` only add SELECT for admins, not write.

**Suggested fix.** Explicitly write `revoke insert, update, delete on discussions from authenticated;` (mirrors the Canvas-cache migration's pattern). This makes the deny-by-default explicit at the GRANT layer; the RLS layer becomes a defense-in-depth.

---

### M8 — `participations` cascade-delete on `students.delete` cascade-deletes participation history when a student is removed from the roster

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:101` — `student_id uuid not null references students(id) on delete cascade`.

If `students` rows are ever deleted (which today's code doesn't do — finalizeDiscussion only upserts — but the teacher-delete-cascade at line 38 of `students` table cascades from teacher delete), all historical participation rows for that student vanish. The discussion still exists but has fewer participations than recorded.

The bigger risk: if a future "remove student from roster" admin action ever deletes the `students` row instead of soft-deleting, all of that student's historical Harkness participation is wiped from super-grader's collection too (envelope rebuild returns null for that user_id).

**Suggested fix.** Change `students` to soft-delete (`deleted_at timestamptz`). Filter scrubber roster and envelope queries on `deleted_at IS NULL`. Don't cascade-delete historical attribution.

---

### M9 — Storage signed-upload URL for `prepare` is valid for ~1 hour with `upsert: true` → teacher's tab left open + leaked URL = unauthorized overwrite

**Files:**
- `apps/web/src/lib/actions/prepare-discussion-upload.ts:63-71` — `createSignedUploadUrl(storagePath, { upsert: true })`. The signed URL is in the server-action response and exposed to the client (and any debugger/screen-share viewer).

If the URL is leaked (DevTools network tab screenshot during a teacher's tutorial, a logged response in a Sentry breadcrumb, browser extension scraping responses), within the ~1h window anyone with the URL can PUT arbitrary bytes to that storage path. `upsert: true` means there's no "slot is taken" error.

The path is `${teacher.id}/${canvasAssignmentId}/${sectionSlug}/recording.${ext}` — predictable. Combined with a leaked teacher_id and assignment_id, the slot is computable.

**Suggested fix.**
1. Drop `upsert: true`. Once the slot is taken, force a new path.
2. Shorter signed URL TTL (default Supabase 1h is long; 5 minutes is plenty for the recorder upload flow which is sub-second after Stop).
3. Verify on finalizeDiscussion that the uploaded object's etag matches what was expected (e.g., upload returns ETag, store it on the row, refuse to advance state if ETag drifts).

---

### M10 — `participations` UNIQUE on (discussion_id, student_id) doesn't dedupe identical canvas_user_id participations within the same discussion

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:103` — `unique (discussion_id, student_id)`. Constraint on student_id (UUID).
- `apps/web/src/lib/actions/upload-discussion.ts:122-127` — `students` upsert on `(teacher_id, canvas_user_id, canvas_course_id)`. So one canvas_user_id → at most one students row per (teacher, course). OK in normal case.

If a student appears in multiple sections of the same course AND the teacher picks them twice via the participant checklist (UI bug or duplicate Canvas roster entries), the upsert yields one students row, and the participation insert has one entry. The UNIQUE catches if you try to add the same student twice. OK.

But: if the student is in TWO courses and the teacher records under one course, the student's primary `students` row is for THAT course. If the same canvas_user_id later participates in a discussion for ANOTHER course, a SEPARATE `students` row gets minted (per the (teacher_id, canvas_user_id, canvas_course_id) unique constraint). Super-grader's envelope build at `envelope.ts:46-52` joins `participations → students` by canvas_user_id — could match EITHER students row. Whichever is in the participation row at discussion-time is what's surfaced. OK if the participation row uses the right student row id (which it does — finalizeDiscussion looks up the rosterById map by canvas_user_id).

Low risk; flag for awareness.

---

## LOW

### L1 — `discussion_state` enum has no migration path documented for adding new states

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:59-65` — `create type discussion_state as enum(...)`.

If a future migration adds a state (e.g., `'preparing'` per H1's suggestion), PG enum-ALTER is a forward-only operation that requires careful migration ordering. Worth flagging now so the next state addition doesn't surprise the team.

---

### L2 — `discussions_state_idx` partial index covers only `('uploaded', 'transcribing')`

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:91-92` — `create index discussions_state_idx on discussions (state) where state in ('uploaded', 'transcribing')`.

The dashboard's polling-driver predicate at DiscussionList line 64-70 uses these two states, so the index is well-targeted. But future queries that want to find "stuck transcribed but not posted" rows (relevant to the H6 partial-success retry sweeper) won't be index-supported.

**Suggested fix.** Expand to `state IN ('uploaded', 'transcribing', 'transcribed')` once a sweeper for stuck-transcribed-but-not-posted exists.

---

### L3 — `updated_at` is double-bumped: trigger + manual writes

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:124-125` — trigger sets `updated_at = now()` on every UPDATE.
- `apps/web/src/lib/peers/notify.ts:191-196` — uses `updated_at` as `completed_at` in the envelope.

Every diagnostic write (status flip, error_message update) bumps `updated_at`, which means `completed_at` in the SG envelope drifts every time HH writes anything to the row — not just transcription completion. The teacher-visible "completed at this time" is therefore "row was last touched at this time", which is a different semantic.

**Suggested fix.** Add a `discussions.completed_at timestamptz` column. Set it once when state transitions to 'transcribed'. Read it (not updated_at) in the envelope.

---

### L4 — Inngest function `retries: 2` is aggressive for Gemini-billable steps

**Files:**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:50-52` — `retries: 2`.

With 2 retries (3 total attempts), a transient Gemini outage that causes gemini-transcribe to throw triple-bills the teacher's Gemini budget. The check-rate-limit step protects against per-day cap but not within a single discussion. (Inngest's step memoization means retries of a SINGLE failed step don't re-call check-rate-limit, but they DO re-call Gemini.)

**Suggested fix.** Lower `retries` to 1 for the Gemini-touching steps via per-step configuration (if Inngest supports — otherwise lower function-level). Or implement a "Gemini call dedup" sidecar: after a successful Gemini call, cache the response by `(discussionId, prompt_id)` so retries hit cache.

---

### L5 — `audio_url` storage path leaks teacher.id (UUID) into client-visible content

**Files:**
- `apps/web/src/lib/actions/prepare-discussion-upload.ts:61` — path includes teacher.id.
- `apps/web/src/app/dashboard/page.tsx:107-115` — signed URL exposes the path in the URL's signature payload.

Not a privacy violation (teacher's own UUID), but it's an unnecessary disclosure of an internal id to client surface area. Future-proofing: use the discussion id (also UUID, but newly generated per-discussion) as the path prefix instead.

---

### L6 — No CHECK constraint enforces `state='posted_to_super_grader' → super_grader_post_status='posted'`

**Files:**
- `supabase/migrations/20260513120000_initial_schema.sql:73-88` — no inter-field CHECK.

A future bug that writes `state='posted_to_super_grader'` while leaving `super_grader_post_status='pending'` (or any non-`'posted'` value) wouldn't be caught at the DB layer. Today's code at `notify.ts:180-197` correctly couples them, but the coupling isn't expressed in the schema.

**Suggested fix.** Add: `CHECK (state <> 'posted_to_super_grader' OR super_grader_post_status = 'posted')`.

---

### L7 — `discussion-audio` bucket allows `audio/webm` but Gemini Files API doesn't accept it

**Files:**
- `supabase/migrations/20260516120000_discussion_audio_bucket.sql:21` — bucket allowed_mime_types includes `audio/webm`.
- HH CLAUDE.md gotcha: "Gemini Files API does NOT accept `audio/webm`".

A Firefox-only user (which only supports webm/opus per the recorder's preference list) can successfully upload but transcription fails. The bucket allows the upload but the pipeline doesn't support it. The pickMimeType function does pick a fallback, but if a user's Firefox actually picks webm and uploads, the failure is downstream.

**Suggested fix.** Reject webm in the bucket allowed_mime_types — fail fast at upload time. Surface a clear "this browser isn't supported for recording; use Chrome or Safari" error in the Recorder. Or: transcode webm → mp4 client-side before upload (heavier; not necessary if Safari/Chrome cover the user base).

---

## Themes

Across this audit: **5 fail-open, 4 missing-fence, 3 no-idempotency, 2 no-snapshot, 1 no-txn**. The most expensive themes are fail-open (C1 / C4 — empty roster silently skips anonymization) and missing-fence (C3 / C5 — every UPDATE in the state machine lacks the `.eq("state", expected)` guard). Snapshot semantics around the prompt body (C2) and roster (C1) follow the same pattern the OE/AID/HAH audits surfaced — HH inherits the same root architecture, so the same fixes apply (immutable historical prompt rows, persisted roster snapshot on the discussion row at finalize time). The biggest privacy bleed risk is C1 (un-scrubbed real student names landing in DB + going to super-grader); the biggest financial bleed risk is C3 / H5 (delete-mid-transcription wasting two Gemini calls on a ghost discussion). The two-pass design is sensible — the transcript survives a failed summary — but the onFailure handler (C5) silently undoes that resilience by clobbering happy terminal states. None of these are exploitable by an external attacker; they all require benign operator actions (admin edits a prompt, teacher hits Delete, two clicks, Inngest at-least-once delivery) to manifest.
