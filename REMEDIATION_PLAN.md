# Harkness Helper — Remediation Plan

Strategic plan to address the structural bugs surfaced by the 2026-05-22 multi-agent code review (M6.22). Audits covered six themes in parallel:

1. Discussion + participation state machine + audio pipeline + RLS → `audits/audit-discussion-state.md`
2. PII scrubbing + anonymizer + audio/transcript boundary → `audits/audit-pii-scrub.md`
3. Canvas integration + TargetPicker + roster sync → `audits/audit-canvas.md`
4. Auto-save + admin prompts + recording UI → `audits/audit-auto-save.md`
5. Cross-system seams (SG webhook, Inngest, Storage, retention, Sentry) → `audits/audit-seams.md`
6. Auth + RLS + storage + token security + setup-page divergence → `audits/audit-auth-rls.md`

**Total findings: 16 CRITICAL, 31 HIGH, 30 MEDIUM, 21 LOW ≈ 98 issues.** Roughly the same volume as HAH's M6.21 review, but the actively-leaking surface is different. **HH's hardest PII surface is audio of students speaking** — every utterance crosses the EHS↔Google boundary at Gemini Pass 1 (audio cannot be pre-scrubbed). The contract is "Gemini sees real names spoken aloud, the transcript text returns, HH scrubs the text before persisting." Three independent failures in the current implementation defeat that contract at the same time, and the seeded summary prompt actively instructs Gemini to put real names BACK INTO the output.

## Headline criticals (actively leaking)

1. **Scrubber fail-open at three independent layers.** `finalizeDiscussion` roster fetch, Inngest worker roster fetch, and `scrubText` itself all silently no-op when `course_rosters` is missing or empty. Any fresh teacher / sync-error / Canvas-course-id drift produces a discussion whose transcript + summary write to `discussions.transcript` + `discussions.summary` with real student names AND ship them downstream to super-grader via the per-participant POST. (audit-discussion-state C1; audit-pii-scrub F1, F2)

2. **`scrubText` regex only matches the full `display_name`.** Harkness audio is dominated by first-name utterances ("Sarah, what's your take?", "I agree with Liz") and possessives ("Sarah's point was…"). The current regex `\b<display_name>\b` requires the literal full name in the transcript — which Gemini almost never produces, because the speakers don't say full names. Every transcript that exits HH today contains real first names. (audit-pii-scrub F3)

3. **The seeded summary prompt explicitly instructs Gemini to leak names.** `migrations/20260516170000_v1_prompts.sql:38` (the seeded `GROUP_FEEDBACK` v1 prompt) literally says **"Credit specific students by name"** — contradicting Pass 1's "use `Student_xxxxxx`" stance and instructing the model to put real names BACK INTO the summary output. Even if Pass 1 produced a perfectly scrubbed transcript, Pass 2's prompt asks for un-scrubbing on every summary. (audit-pii-scrub F4)

4. **Non-constant-time bearer compare** at `lib/peers/auth.ts:21` — `!==` instead of `crypto.timingSafeEqual`. Gates BOTH `/api/super-grader/result` and `/api/super-grader/prompt`. A timing oracle leaks `HARKNESS_API_TOKEN` byte-by-byte, after which every transcribed discussion's signed audio URL (raw student voice) + full transcript + summary + all four system prompt bodies are reachable. (audit-seams C; audit-auth-rls H2)

5. **Plaintext Google refresh tokens on `teachers.google_refresh_token`** readable by any admin via the `teachers_admin_select` RLS overlay. A `pg_dump`, a backup leak, or a curious admin = durable Drive impersonation against every teacher's account. No `*_ENC_KEY` envelope; no separate restricted-RLS table. (audit-auth-rls H1)

6. **No state fence on `discussions.state` UPDATEs anywhere in the pipeline.** Every `UPDATE discussions SET state=...` is unconditioned. Combined with **no `id:` on `inngest.send`** (`upload-discussion.ts:153`), duplicate `discussion.uploaded` events spawn parallel `transcribe-discussion` runs that race past the entry-state guard, double-burn the Gemini rate-limit RPC, both write transcripts to the same row (last-write-wins, non-deterministic content), and double-fire the SG webhook fan-out. Delete-mid-transcription burns two Gemini calls on a ghost discussion with no log surfacing the waste. (audit-discussion-state C3; audit-seams second-highest)

7. **TargetPicker silently clobbers manual de-selections every 5 seconds.** The default-all-in-section effect re-fires every dashboard polling tick because `rostersByCourseId` is a fresh object reference on every server re-render. A teacher who unchecks two students from the picker, leaves the page open during transcription (which polls every 5s via `router.refresh()`), and submits — gets all-students-in-section anyway. Wrong participants land in `participations`, wrong scrub roster gets compiled, downstream SG data is wrong. (audit-canvas C1)

8. **Tab close mid-record silently discards the entire audio recording.** `chunksRef.current` is in-memory only; no IndexedDB persistence; no `beforeunload` warning; no recovery flow. A 90-minute Harkness recording lost to one accidental `⌘W` is one keystroke away. (audit-auto-save C2)

9. **Auto-save cross-editor race in `/admin/prompts`.** Four PromptEditors mount under one `AutoSaveProvider`. `saveSystemPrompt` has no single-flight guard and no `updated_at` fence. Two admins editing different prompts (or one admin tab-switching between prompts) race writes — silent overwrite of in-flight edits, no version-conflict surface. (audit-auto-save C1)

10. **No retention sweep — at all.** Two code comments (`upload-discussion.ts:97`, `delete-discussion.ts:29`) reference a "retention sweep" that does not exist. No `/admin/retention` page, no `/api/admin/retention/*` routes, no cleanup-blobs Inngest cron. Audio recordings of student voices accumulate indefinitely. FERPA-shaped gap. (audit-seams C)

11. **No Sentry at all.** No `instrumentation.ts`, no `instrumentation-client.ts`, no `@sentry/*` imports anywhere. Production errors disappear into the void; PII scrubber concerns are moot because there's nothing to scrub. (audit-seams C)

The audits also identified the same five recurring root causes as the OE / AID / HAH reviews. Almost every individual bug maps to one of them. Patching point-by-point would leave the patterns intact; the same shape of bug would re-appear in the next feature. This plan groups fixes by structural theme so each phase eliminates a *class* of bugs.

## Status (as of 2026-05-22)

Active-bleed phases pending. Structural critical path is **0 → 0b → 0c → 1 → 2 → 3**, mirroring HAH M6.21.

| Phase | State | Commit |
|---|---|---|
| 0 — Stop the PII bleed (scrub fail-closed + first-name scrub + summary prompt) | Pending | — |
| 0b — Auth boundary criticals (timingSafeEqual + token encryption) | Pending | — |
| 0c — Retention + Sentry (data accumulation + observability holes) | Pending | — |
| 1 — Snapshot semantics on discussion finalize | Pending | — |
| 2 — State fences + Inngest idempotency | Pending | — |
| 3 — TargetPicker clobber + recording loss + auto-save races | Pending | — |
| 4 — Roster sync correctness + finalize validation | Pending | — |
| 5 — Canvas client + section integrity | Pending | — |
| 6 — Polish + small risks | Pending | — |
| 7 — Verification + observability | Pending | — |

## Operator follow-ups (deploy checklist for Phase 0 / 0b / 0c)

These items must complete BEFORE or SHORTLY AFTER the Phase 0/0b/0c commits deploy to production.

### Required before deploying Phase 0b to production

1. **Generate + set `TEACHER_GTOKEN_ENC_KEY`.**
   ```
   openssl rand -base64 32
   ```
   Add to Vercel env vars (production + preview + development scopes — see global CLAUDE.md for the per-scope add-via-CLI gotchas) and to local `.env.local`. Without this, every new teacher sign-in's Google-token write logs an encryption error and the teacher can't write to Drive.

2. **Run a one-off backfill** to encrypt every existing teacher's plaintext tokens. ~20 lines: read each `teachers` row with non-null `google_access_token` OR `google_refresh_token`; `encryptSecret()` both; write the `*_encrypted` columns; null the plaintext columns. Idempotent — safe to re-run. Verify via SQL: `SELECT count(*) FROM teachers WHERE google_access_token IS NOT NULL OR google_refresh_token IS NOT NULL;` should hit 0.

3. **Ship a follow-up migration dropping the legacy plaintext columns** once #2 confirms clean:
   ```sql
   ALTER TABLE public.teachers
     DROP COLUMN google_access_token,
     DROP COLUMN google_refresh_token;
   ```
   Then remove the legacy-column fallback in `lib/google/auth.ts`. Migration + code change in one PR.

### Required after EVERY Vercel deploy that touches Inngest functions

4. **PUT `/api/inngest` to re-sync Inngest registration.** Suite-wide gotcha (`feedback_inngest-resync-after-vercel-rename.md`) — events 200 silently but never fire until re-synced.
   ```
   curl -s -X PUT https://harkness-helper-v2-sgs.vercel.app/api/inngest
   ```
   Phase 0 and Phase 2 both modify `transcribe-discussion`; re-sync after each deploys.

### Operator-only fixes (post-Phase 0)

5. **Edit the seeded summary prompt body.** Phase 0 ships the new default, but existing production rows in `prompts` (purpose=`summary`) still carry the v1 GROUP_FEEDBACK text that says "Credit specific students by name." After deploying Phase 0, run an `UPDATE prompts SET body = ... WHERE purpose = 'summary'` against production (via `/admin/prompts` UI is fine — auto-save persists). The Phase 0 migration MAY repoint the seed, but only fresh installs read seeds; existing rows are sticky.

6. **Set `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN`** in Vercel env vars once Sentry is provisioned (Phase 0c). The wiring lands env-gated, so production stays no-op until DSN set — but until set, all errors disappear.

### Tracking

This section gets pruned as items complete. Once an item ships, move it to the Phase 0/0b/0c "Done" entries above with the relevant commit ref + delete from this list.

## Recurring root causes (same as OE M6.19 + AID M6.20 + HAH M6.21)

1. **No snapshot semantics.** `discussions` and `participations` hold live FK references to `prompts.body` (transcription + summary prompts) and `course_rosters` JSONB. Mid-flight admin prompt edits change which prompt the worker uses; mid-flight roster sync changes which students the scrubber recognizes. The Inngest worker reads BOTH prompts (transcription + summary) live at job time — a teacher editing the prompt mid-job can produce a Pass 1 + Pass 2 against different prompt versions.

2. **No state fences on UPDATEs.** Every `UPDATE discussions SET state=...` in `transcribe-discussion.ts` and `upload-discussion.ts` is unconditioned. A duplicate Inngest event (no `id:` on `send`) lets two workers race past the entry-state guard, both flip state from `uploaded` → `transcribing`, both call Gemini, both write transcripts (last-write-wins).

3. **No transactional boundaries across subsystems.** `transcribe-discussion` = roster fetch + Gemini Files upload + Pass 1 + Pass 2 + DB writes + SG webhook fan-out. Each step writes to a different system; partial failure leaves divergent state. Specifically: Pass 1 success + Pass 2 failure — does the row land in `transcribed` (without summary) or `failed` (losing the successful transcript)?

4. **Fail-open instead of fail-closed.** The big one for HH. Empty `course_rosters` row → scrub no-ops, real names persist. Empty roster passed to `compileNameMap` → returns an empty map → `scrubText` returns input unchanged. DB error on roster lookup → fall-through to empty roster. No distinction between "no students" and "DB error." Same shape OE / AID / HAH all had at their satellite-side scrub layer.

5. **No retry / idempotency semantics.** Inngest `send` without `id:` lets duplicate events fire two workers. Per-participant SG webhook fan-out has no per-row idempotency key. The auto-save server action has no single-flight guard.

## Strategic shape

| Theme | Phase | Root cause it kills | Bug count addressed |
|---|---|---|---|
| Stop the PII bleed | **0** | Fail-open scrub + first-name gap + leak-encouraging prompt | 4 critical |
| Bearer + token encryption | **0b** | Plaintext secrets + timing oracle | 2 critical |
| Retention + Sentry | **0c** | Data accumulation + no observability | 2 critical |
| Snapshot semantics | **1** | FK-not-snapshot drift | ~5 high |
| State fences + idempotency | **2** | UPDATEs without guards + duplicate Inngest fires | ~6 critical/high |
| TargetPicker + recorder + auto-save races | **3** | UI-side races that produce wrong data / lost work | ~4 critical/high |
| Roster sync hardening + finalize validation | **4** | Silent zero-roster + dropped participants | ~4 high |
| Canvas client + section integrity | **5** | Cache + cross-teacher uniqueness | ~3 medium |
| Polish + small risks | **6** | Misc | ~20 medium/low |
| Verification + observability | **7** | Future regression | enabling |

**Sequencing principle:** Active bleeds first (0 + 0b + 0c, same-day where possible). Then schema enablers (Phase 1 snapshots) so other phases have the data they need. Then code that depends on schema (2). Then UI race fixes (3). Then parallel cleanup tracks (4, 5, 6, 7).

Recommended order if linear: **0 → 0b → 0c → 1 → 2 → 3 → 4 → 5 → 6 → 7**.

---

## Phase 0 — Stop the PII bleed

**Audit refs:** `audit-pii-scrub.md` F1, F2, F3, F4, F5, F13, F14; `audit-discussion-state.md` C1, C4.

### Deliverables

1. **Make roster fetch fail-closed.** Drop the silent `try/catch` (and the `?? []` fallbacks) in both `finalizeDiscussion`'s roster fetch and `transcribe-discussion.ts`'s roster fetch. Distinguish "no rows" from "DB error" from "RLS-denied." Throw a typed `RosterMissingError` with named cases (`missing_row`, `empty_students`, `null_email_student`). The Inngest worker catches it, flips `discussions.state='failed'`, writes `super_grader_post_status='roster_missing'`, and DOES NOT call Gemini. Mirrors OE Phase 0's `RosterMissingError` pattern.

2. **Fix `scrubText` to handle the dominant Harkness utterance form.** The current `\b<display_name>\b` regex matches only the full name. Replace with a `nameVariants` map per student that includes:
   - Full display name
   - First name only (case-insensitive)
   - Last name only (case-insensitive)
   - Possessive forms (`'s`, `'`)
   - Common nickname expansions (load from a small static map: `Robert→Bob,Rob`, `Elizabeth→Liz,Beth,Ellie`, etc. — the longer-term fix is a per-student "also-known-as" column, but a static map ships immediately).
   - Unicode word boundaries (`\p{L}` instead of `\b` — handles accents)
   - Longest-first ordering preserved.
   - Result for every variant: `Student_xxxxxx` (the student's anonymized token).

3. **Rewrite the seeded summary prompt to NOT instruct Gemini to use real names.** Delete the "Credit specific students by name" sentence in the `summary` prompt body. Replace with: "Refer to students by their anonymized token (`Student_xxxxxx`). Do NOT use real names — those have been removed for privacy and any real name in your output is a privacy violation." Both update the seed (migration `20260522010000_fix_summary_prompt_seed.sql`) AND issue an `UPDATE prompts SET body=... WHERE purpose='summary'` in the same migration (since existing rows are sticky and seeds only apply to fresh installs).

4. **Verify Pass 2 receives the scrubbed transcript, not the raw one.** Trace the code path in `transcribe-discussion.ts`. If Pass 2's input is `verbatimTranscript` instead of `scrubbedTranscript`, fix to use the scrubbed version — real names cross to Gemini unnecessarily on Pass 2 (Pass 1 we can't avoid; Pass 2 we can).

5. **Snapshot roster at finalize time.** Add a `roster_snapshot jsonb` column to `discussions`. Populate at `finalizeDiscussion` (with the validated, all-emails-present roster). The Inngest worker reads from the snapshot, not the live `course_rosters` row. Closes the race where a roster sync mid-job changes which students the scrubber recognizes.

6. **Add the salt-length floor check** that SG enforces and HH skips. `packages/anonymizer/...`: `if (saltBytes.length < 16) throw new Error("SUPER_GRADER_SALT must be ≥16 bytes")`. Closes the silent-no-op-on-misconfigured-salt vector.

7. **Add scrubber tests.** Currently zero tests. Land at least one regression test per name-variant case + the empty-roster fail-closed case + the salt-floor case.

**Acceptance:** Every codepath that produces text destined for Gemini OR persists Gemini output runs through a compiled, validated roster or refuses to call Gemini. Production transcripts from the past week contain no real student names in `discussions.transcript` or `discussions.summary`. The summary prompt explicitly forbids real names. Mirror of OE Phase 0 (`9dc96db`) + AID Phase 0 (`685b643`) + HAH Phase 0 (`02f41c9`), expanded for HH's scrub-regex + summary-prompt criticals.

---

## Phase 0b — Bearer compares + Google token encryption at rest

**Audit refs:** `audit-seams.md` C (timingSafeEqual); `audit-auth-rls.md` H1 (plaintext tokens), H2 (bearer compare).

### Deliverables

1. **`crypto.timingSafeEqual` for bearer compares.** `lib/peers/auth.ts:21` — `!==` → `crypto.timingSafeEqual` with length pre-check. Closes the timing-oracle that gates BOTH `/api/super-grader/result` and `/api/super-grader/prompt`. Length-mismatch must return false BEFORE the timing-safe compare to avoid throwing.

2. **Verify token-presence fail-closed.** If `process.env.HARKNESS_API_TOKEN` is unset or empty string, the route MUST reject all requests. Currently if it's `undefined`, the `req.token === undefined` compare would let an empty bearer through. Add explicit `if (!process.env.HARKNESS_API_TOKEN) return 503` at the top.

3. **AES-256-GCM encrypt `teachers.google_access_token` and `google_refresh_token`** using `TEACHER_GTOKEN_ENC_KEY` (a new env var; clean rotation scope vs reusing any existing key).

4. **Migration:** `google_access_token_encrypted bytea`, `google_refresh_token_encrypted bytea`; populate from the existing plaintext columns in a single transaction; drop the plaintext columns in a follow-up migration once readers are flipped.

5. **Update `lib/google/auth.ts`** to decrypt at read time. Encrypt at write time in `/api/auth/callback/route.ts`.

6. **Document key rotation** in the suite-root `INCIDENT_RESPONSE.md` (mirrors `scripts/rotate-canvas-enc-key.sh` pattern from HAH 0c).

7. **Tighten teacher self-UPDATE RLS policy.** Currently teachers can rewrite their own `email` and `google_*` columns via PostgREST. Restrict the UPDATE policy to a column list that excludes `email`, `google_access_token_encrypted`, `google_refresh_token_encrypted`, and `google_token_expires_at`. Use Postgres column-level grants or a SECURITY DEFINER `update_teacher_profile(...)` RPC.

**Acceptance:** A `pg_dump` of `teachers` shows ciphertext, not Drive tokens. A curious admin with `teachers_admin_select` RLS access reads ciphertext. The bearer endpoints survive a Wfuzz timing-oracle attack. Teachers cannot self-modify their `google_*` columns via the REST API. Mirror of HAH Phase 0c (`9a267bd`) shape.

---

## Phase 0c — Retention sweep + Sentry observability

**Audit refs:** `audit-seams.md` C (retention absent), C (Sentry absent).

### Deliverables

1. **Add a `discussions.state='archived'` enum value** for soft-deleted (retention-archived) discussions.

2. **Add `/api/cron/sweep-discussions`** (or an Inngest cron):
   - Daily at 03:00 UTC, `CRON_SECRET`-gated.
   - Hard-delete discussions where `state IN ('transcribed','posted_to_super_grader','failed','archived')` AND `created_at < now() - interval '13 months'` (per suite-wide `RETENTION_MONTHS=13`).
   - Order: delete Storage blob FIRST (`discussion-audio` bucket), then DB row CASCADE. Two-step required: a single transaction can't atomically delete a Storage object.
   - Log each deletion to a `retention_log` table (audit trail).

3. **Add `/admin/retention`** UI:
   - List discussions older than the configured retention window.
   - CSV export (UTF-8 BOM, mirroring HAH).
   - Chunked hard-delete button (200/batch) with "type DELETE" confirm. Server-side rejects null `beforeDate`.

4. **Add an auto-archive pass** for stale `uploaded`/`transcribing` rows (Inngest crashed mid-job, no recovery): daily, `state IN ('uploaded','transcribing')` AND `created_at < now() - interval '14 days'` → `state='archived'` + Storage cleanup.

5. **Wire Sentry.** Add `instrumentation.ts` + `instrumentation-client.ts` at the repo root. Env-gated on `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` (no-op until set). Include a `beforeSend` hook that scrubs PII from exception messages + breadcrumbs (regex: `Student_[a-z0-9]{6}` is allowed; anything else matching common name shapes gets redacted). Mirror HAH's `lib/telemetry/sentry-init.ts` if present.

6. **Session Replay off (or maskAllText on).** If Sentry includes Session Replay, mask the DOM at capture time (the recording UI shows roster names mid-picker). Default to `maskAllText: true` + `blockAllMedia: true`.

7. **Sentry-DSN-absent fail mode test.** When `SENTRY_DSN` is unset, the wiring must be a no-op — verify on local dev startup.

**Acceptance:** Audio recordings older than 13 months are auto-purged. Production errors land in Sentry with PII scrubbed. The `/admin/retention` page exists and respects state fences. Mirror of HAH Phase 3 + Phase 8 retention/Sentry shape, but HH's were ABSENT not just buggy.

---

## Phase 1 — Snapshot semantics on discussion finalize

**Audit refs:** `audit-discussion-state.md` C2 (prompt body live), H4 (roster live), H7 (template drift).

`discussions` references `prompts.body` (transcription + summary prompts) and `course_rosters.students` LIVE. Worse, two prompts are read by the same job (Pass 1 transcription, Pass 2 summary) — a teacher editing one mid-job produces an inconsistent run.

### Deliverables

1. **New migration: snapshot columns on `discussions`:**
   - `transcription_prompt_body_snapshot text` + `transcription_prompt_version_at_finalize int`
   - `summary_prompt_body_snapshot text` + `summary_prompt_version_at_finalize int`
   - `roster_snapshot jsonb` (the validated, all-emails-present roster — already added in Phase 0)
   - `scrub_status text NOT NULL DEFAULT 'ok'` check (in ('ok','failed','skipped'))

2. **Populate at finalize-row INSERT** (the `finalizeDiscussion` server action). Lock both prompts + roster + section context at finalize start. The entire two-pass job shares them.

3. **Read from snapshots in `transcribe-discussion.ts`:**
   - Pass 1 uses `transcription_prompt_body_snapshot`
   - Pass 2 uses `summary_prompt_body_snapshot`
   - Scrubber compiles from `roster_snapshot`
   - Fallback to live read for legacy rows (sentinel: `transcription_prompt_body_snapshot IS NOT NULL`).

4. **Flip the `prompts → discussions` FK from CASCADE to RESTRICT** (admin can't delete a prompt that has live discussion sessions referencing it). Snapshot column means we don't NEED the FK, but the RESTRICT closes the orphan-archeology vector.

5. **Drop any in-process prompt cache** if one exists in HH (CLAUDE doesn't mention one; verify in `lib/prompts/`). The snapshot IS the cache.

**Acceptance:** Pass 1 and Pass 2 of the same job ALWAYS see the same prompt versions. A teacher editing prompts mid-job cannot retroactively change a running discussion's text. Direct mirror of OE Phase 1 (`8828428`) + AID Phase 1 (`ecc3abd`) + HAH Phase 1.

---

## Phase 2 — State fences + Inngest idempotency

**Audit refs:** `audit-discussion-state.md` C3, C5, H1, H6 (state fences absent everywhere); `audit-seams.md` C (no inngest event id).

### Deliverables

1. **Add `.eq("state", expected)` fence to every `discussions.update`** that touches state. Catalog every UPDATE call in `transcribe-discussion.ts`, `upload-discussion.ts`, `delete-discussion.ts`, and the SG webhook fan-out. Each must be conditional on the prior state.

2. **Add `id:` to every `inngest.send`.** The natural key is `discussion-uploaded:${discussionId}` for `discussion.uploaded` events. Without this, Inngest dedups by `(name, ts, data)` which is hash-window-sensitive — a fast double-fire passes through.

3. **Wrap state transitions in a SECURITY DEFINER RPC.** `begin_transcription(discussion_id)` flips state `uploaded → transcribing` atomically with a `FOR UPDATE` lock; raises `P0001` with `wrong_state` if not in `uploaded`. Same shape for `complete_transcription(discussion_id, transcript, summary, super_grader_post_status)`. Mirrors OE's `begin_exam_session` pattern.

4. **Per-participant SG push idempotency.** Add a `participations.super_grader_post_status text` + `super_grader_post_attempted_at timestamptz` per participant row (not just the aggregate `discussions.super_grader_post_status`). Per-participant POST records its own success/failure. The aggregate flip to `posted_to_super_grader` only happens when ALL participations have `super_grader_post_status='ok'`. Retries (Phase 6) operate on the failed-participant subset, not the whole discussion.

5. **Two-pass partial-success policy.** Pass 1 success + Pass 2 failure: write the transcript to `discussions.transcript`, set `state='transcribed'`, record `summary_status='failed'` + `summary_error` (new columns). DO NOT mark `state='failed'` — the transcript is valuable and the user should still see it.

6. **Idempotent delete.** `delete-discussion.ts` — Storage-delete first, then DB row delete with `.eq("state", expected)` fence. Two concurrent delete clicks: one succeeds, one fast-paths out.

**Acceptance:** Two concurrent `discussion.uploaded` events produce exactly one transcription run, one summary, one SG fan-out. Inngest function-level re-runs don't re-bill Gemini. A deletion mid-transcription doesn't burn Gemini calls on a row that no longer exists (or the system reports the cost and refuses to delete in-flight). Mirror of OE Phase 2 + AID Phase 2 + HAH Phase 2.

---

## Phase 3 — TargetPicker + recorder + auto-save races

**Audit refs:** `audit-canvas.md` C1 (TargetPicker auto-clobber); `audit-auto-save.md` C1 (cross-editor race), C2 (recording loss).

Three independent UI-side races that produce wrong data or lost work.

### 3a — TargetPicker auto-clobber

1. **Stable `rostersByCourseId` reference.** The 5s polling refresh creates a fresh object on every server render → the default-all-in-section `useEffect` dependency triggers → de-selections silently clobbered. Fix: memoize `rostersByCourseId` by structural equality (or store roster outside the polling cycle), AND change the effect to only fire when the *picker's binding* changes (course/section), not when the roster reference changes.

2. **Persist picker state.** Save selected participants in `sessionStorage` keyed by `(course_id, section_id)`. On effect-fire-from-roster-change, prefer the persisted set over the default-all.

3. **Move the picker out of the polling refresh tree.** Either the picker's component sits in a parent that doesn't `router.refresh()`, or the picker uses a client-side `swr`/local-state pattern that doesn't get re-rendered on poll.

### 3b — Recording loss on tab close

1. **Persist MediaRecorder chunks to IndexedDB.** Every chunk from `MediaRecorder.ondataavailable` (default 1s timeslice) writes to IndexedDB with a key `(teacher_id, recording_session_uuid, chunk_index)`. On tab reopen, check IndexedDB for any orphan recording-session; offer recovery UI.

2. **`beforeunload` warning** if a recording is active. Standard browser-confirm "you have unsaved work" dialog.

3. **Recover-from-crash flow.** On `/dashboard` load, if IndexedDB has orphan chunks for the signed-in teacher, surface "you have a partial recording from [time] — recover or discard."

### 3c — Auto-save cross-editor race in /admin/prompts

1. **Single-flight `save()` in `useAutoSaveForm`.** Per-key serialization queue.

2. **Add `updated_at` fence to `saveSystemPrompt`.** Optimistic concurrency: client sends the `updated_at` it last read; server UPDATE includes `AND updated_at = $client_updated_at`. On mismatch, return 409 with the current row so the client can merge.

3. **AutoSaveProvider aggregation by key, not collapse-to-one.** Each PromptEditor registers its `(key, status)` independently; the pill shows aggregate: any error wins; otherwise all-saved wins; otherwise any-saving wins.

4. **Atomic version bump.** Currently `version` and `body` may update in two queries. Combine into one UPDATE.

**Acceptance:** TargetPicker de-selections persist across polling refreshes. A 90-minute recording survives a tab close + reopen + browser crash. Two admins editing different prompts in `/admin/prompts` cannot silently overwrite each other; concurrent saves serialize correctly.

---

## Phase 4 — Roster sync correctness + finalize validation

**Audit refs:** `audit-canvas.md` H (silent empty roster), H (no sync transaction), H (finalize drops out-of-roster participants), H (cache grows monotonically).

### Deliverables

1. **Surface "Canvas hid email at course level" to the operator.** Currently a course where Canvas returns `email=null` for ALL students results in zero students synced + no error surface. Detect: if `users` endpoint returns N rows and ZERO have an email-shaped value, raise a typed `CanvasEmailHiddenError`. UI shows "Your Canvas API token doesn't have permission to read student emails — ask your Canvas admin to enable [permission name] or use a token with broader scopes."

2. **Transactional sync.** Wrap each course's roster sync in a Supabase transaction (or a SECURITY DEFINER RPC). Mid-sync Canvas 429 + retry exhausted → roll back the partial write rather than persisting a half-roster.

3. **`finalizeDiscussion` validates participant set against the snapshot roster.** Currently any out-of-roster participant is silently dropped. Reject finalize if any picked participant is not in the snapshot — return `participants_out_of_roster=[ids]` so the UI can surface "these students aren't in the roster, re-sync first."

4. **Cache cleanup pass.** `canvas_cache` (or wherever HH stores course/assignment caches) accumulates deleted-in-Canvas courses indefinitely. Daily cron: nightly diff against `state[]=available` Canvas courses; soft-delete missing rows (add `deleted_at` column).

5. **Audit all `cs.email ?? cs.login_id` patterns one more time.** Audit #3 says HH is clean, but a sanity grep across `packages/canvas` + `apps/web/src/lib/actions` + any admin route doesn't hurt. The HAH counterexample is the cautionary tale.

**Acceptance:** A teacher whose Canvas API token hides emails gets a clear error, not a silent empty roster. Mid-sync failures don't persist partial state. Out-of-roster participants surface as an error at finalize time, not as silently-dropped data.

---

## Phase 5 — Canvas client + section integrity + cross-teacher considerations

**Audit refs:** `audit-canvas.md` M (co-teach blocked by unique constraint), M (429-budget-exhaustion uncategorized), M (sync result conflation).

### Deliverables

1. **Composite unique on `discussions(canvas_assignment_id, canvas_section_id)` blocks legitimate co-teach.** If two teachers in the same school each teach a section of the same Canvas course, only one can have a Harkness recording for the shared assignment. Either:
   - Add `teacher_id` to the unique key: `(canvas_assignment_id, canvas_section_id, teacher_id)`.
   - OR document co-teach as an unsupported case and surface a clear error rather than the 23505.

2. **429 error categorization.** Distinct retry semantics for 429 (retry-after, exponential), 5xx (retry with jitter), 4xx (no retry, fail-fast). HH currently sequentializes 429s but the post-budget-exhausted path is uncategorized.

3. **Sync-result UX disambiguation.** "Synced 0 students" today reads identically to "synced fine, no changes." Surface `students_added`, `students_updated`, `students_removed`, `students_skipped` (with reasons) separately.

4. **Token-validity check at setup.** Verify `CANVAS_API_TOKEN` works against a test endpoint before persisting it (HH is single-tenant; this is a less acute issue than for per-teacher-token apps, but still a UX win for setup).

**Acceptance:** Co-teach scenarios produce a clear error or work correctly. Sync results explain what happened. 429s have a documented retry policy.

---

## Phase 6 — Polish + small risks

Grouped low/medium findings. Cherry-pick by appetite.

- TargetPicker's "default-all-in-section" → effect should fire ONCE on bind, not on every render (Phase 3 covers the polling-cycle case; this is the broader principle).
- Teacher self-UPDATE policy excludes `google_*` columns (Phase 0b) — verify in production.
- `INITIAL_ADMIN_EMAIL` bootstrap idempotency under concurrent first-visits (audit-auth-rls MEDIUM).
- Last-admin-lockout read-then-update race (audit-auth-rls MEDIUM).
- Setup-page divergence vs AID (cosmetic — banner-vs-inline-dl). M7.2 candidate.
- Storage bucket UPDATE/DELETE policies (audit-auth-rls MEDIUM — `.remove()` silently fails today).
- Salt-length floor check in anonymizer (Phase 0 covers this).
- Auto-save whitespace-only `min(1)` validation (audit-auto-save MEDIUM).
- `super_grader_response` jsonb on `discussions` — schema check it doesn't grow unbounded for retried-many-times rows.
- The setup-page test buttons — verify each is auth-gated to the signed-in teacher.

---

## Phase 7 — Verification + observability

1. **Integration tests for each of the five root causes** (mirror HAH Phase 9):
   - Snapshot semantics: edit prompt mid-job, confirm worker uses old prompt.
   - State fences: two concurrent finalize calls produce one job.
   - Idempotency: replay a `discussion.uploaded` event, confirm no double-Gemini-burn.
   - Fail-closed: empty roster, confirm worker refuses to write.
   - Retry semantics: simulate SG webhook 500, confirm per-participant retry shape.

2. **Structured logs on every state transition** + every Gemini call + every SG webhook POST. Include `discussion_id`, `participation_id`, `state_before`, `state_after`, `attempt_n`.

3. **Synthetic monitoring.** Daily cron uploads a known-good test audio file, runs through the pipeline, asserts the transcript shape + summary shape, then deletes the test row. Skips the actual SG webhook (use a feature flag).

4. **Daily PII canary.** Script searches `discussions.transcript` and `.summary` for non-tokenized name shapes (first-name-shaped strings not preceded by `Student_`). Alerts if any land. Catches future scrub regressions.

5. **Anonymizer drift CI check.** Wire `scripts/verify-anonymizer-drift.sh` into PR checks for this repo (suite-root script exists).

6. **Inngest stale-registration health check.** Compare `/api/inngest` GET output's `function_count` to expected. Daily cron; alert on mismatch. Closes the suite-wide post-rename gotcha.

---

## Cross-cutting notes

**Mapping to OE M6.19 + AID M6.20 + HAH M6.21:** the structural phases (1, 2, 4, 5, 7) directly mirror the prior three campaigns. The pre-Phase-1 tier (0, 0b, 0c) is HH-specific in shape — same Phase 0 shape as the prior campaigns but with three HH-unique additions: the first-name scrub gap, the seeded prompt that defeats scrubbing, and the entirely-absent retention + Sentry layers. Phase 3 is also HH-specific (TargetPicker + recorder loss + 4-editor auto-save race).

**What's different about HH:**
- **Audio is the input.** Pre-scrubbing isn't possible. The boundary contract is "real names cross to Gemini on Pass 1, get scrubbed in the response text, never persisted." Three independent layers all fail-open today.
- **The seeded summary prompt actively asks for real names back.** Even with Pass 1 scrub fixed, Pass 2 un-scrubs every summary.
- **No retention sweep at all.** HAH had a buggy one; HH has none.
- **No Sentry at all.** HAH had a configured one with PII scrub gaps; HH has none.
- **TargetPicker auto-clobber every 5 seconds.** Unique to HH's polling-refresh + roster-default-effect pattern.
- **Recording loss on tab close.** The 90-minute Harkness-vs-⌘W asymmetry.
- **Auto-save cross-editor race.** HH's 4-prompt admin page hits a pattern OE/AID/HAH didn't trigger.

These mostly add up to a wider Phase 0/0b/0c than the prior campaigns. They are each completable independently (no schema dependencies) so they can ship same-day in parallel commits.

**Open questions to resolve before / during the relevant phase:**
- Phase 0b: encrypt with a fresh `TEACHER_GTOKEN_ENC_KEY` (clean rotation scope) vs reusing any existing key? Recommended: fresh.
- Phase 0c: Sentry plan + DSN tier? — needs operator decision before wiring.
- Phase 1: snapshot at `finalizeDiscussion` time (after roster validation) or at upload-start time? Finalize is cleaner — the upload PUT happens before metadata is known.
- Phase 2: per-participant SG push status as `participations` columns vs a separate `super_grader_pushes` table? Columns are simpler; separate table buys retry history.
- Phase 3a: TargetPicker move out of the polling tree might require restructuring `/dashboard` — bigger refactor than the memoization fix. Pick one based on appetite.
- Phase 3b: IndexedDB chunk persistence — write a small package or inline? Small package is more reusable across siblings (Harkness is unique today but OE has voice recording too).
- Phase 4 cache cleanup: aggressive (delete missing courses) vs soft (mark and hide)? Soft preserves historical reference.

**Phases are independent above Phase 1:** 2 depends on 1 (state fence on snapshot columns); 3, 4, 5, 6, 7 are mostly independent and can be parallelized once 2 is in.
