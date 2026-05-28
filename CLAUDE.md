# Harkness Helper v2

Next.js 16 + Supabase rewrite of the Apps Script v1 (archived at
`~/code/Archived Projects/harkness-helper/`). v1 stays running until v2 is
proven on a real classroom recording.

## Status

See [`../BUILD_PLAN.md`](../BUILD_PLAN.md) for ecosystem-wide milestones.

**Phase B (Canvas + recorder + upload) — done.**
- `packages/canvas` REST client + course/assignment/section caches (with
  `state[]=available` AND active-term filter).
- `/dashboard`: browser MediaRecorder (mp4-first mime for Gemini Files
  API compatibility; wake-lock on record; per-error mic-denied guidance),
  course chips + searchable assignment combobox (harkness-first, by-due-date
  sort), section chips when a course has 2+, participants checklist
  (default-all-in-section). Two-phase upload: (a) `prepareDiscussionUpload`
  server action validates teacher + dedupes + returns a Supabase signed
  upload URL, (b) client PUTs the audio Blob direct to the
  `discussion-audio` bucket (bypasses Next.js/Vercel body caps —
  see Gotchas), (c) `finalizeDiscussion` server action writes
  `discussions` + `participations` rows and fires the Inngest event.
- Sync auto-handles Canvas 429s (Retry-After) and sequentializes per-course
  to stay under Canvas's concurrency budget.

**Phase C (transcription pipeline) — done.**
- Inngest function `transcribe-discussion` triggered by `discussion.uploaded`
  event from the upload action. Durable steps; onFailure marks row
  `state='failed'`.
- Two-pass Gemini 2.5 Flash:
  1. **Verbatim transcript** from audio (Files API simple media upload at
     `/upload/v1beta/files?key=&uploadType=media`, poll until ACTIVE,
     generateContent with `fileData`). Stored on `discussions.transcript`.
  2. **Group feedback summary** (text-only generateContent) from the verbatim
     transcript using v1's `GROUP_FEEDBACK` prompt with `{grade}` and
     `{transcript}` placeholders filled. Stored on `discussions.summary`.
- Roster-driven name scrub on both outputs via `@harkness-helper/anonymizer`
  `scrubText(text, roster)` (full-name whole-word, longest-first to avoid
  partial clobbers).
- Live state updates on `/dashboard` via `router.refresh()` polling every
  5s while any row is `uploaded` or `transcribing`.

**Phase D (super-grader webhook + prompt-pull) — done 2026-05-17.**
- `GET /api/super-grader/result` returns `PeerResultEnvelope<HarknessSummary>`
  for a `(canvas_user_id, canvas_assignment_id)` pair. Joins
  `participations → students` by `canvas_user_id`, picks the newest
  discussion in `state in ('transcribed','posted_to_super_grader')`,
  signs the audio URL with a 1-hour TTL, returns transcript + summary
  as-is (already roster-scrubbed at write time).
- `GET /api/super-grader/prompt?key=<purpose>` returns
  `{body, version, updated_at}` for super-grader's `fetchLivePrompt`.
  `?key=` maps to `prompts.purpose` (transcription / summary /
  speaker_identification / individual_feedback). HK has no `version`
  column, so version is derived from `updated_at` as epoch seconds.
- Bearer-auth via `HARKNESS_API_TOKEN` (`lib/peers/auth.ts`).
- Inngest's `transcribe-discussion` gained a `push-to-super-grader` step
  after `save-summary`. `pushDiscussionToSuperGrader` in
  `lib/peers/notify.ts` fans out one POST per participant in parallel
  (SG's `peer_results` is keyed per-student). Status persisted to
  `discussions.super_grader_post_status` + `super_grader_response`
  (jsonb). On full success, `state` → `posted_to_super_grader`. Best-
  effort: pushDiscussionToSuperGrader never throws, so onFailure can't
  clobber `state='transcribed'`.
- `HARKNESS_TRANSCRIPT_MARKER` + `prependHarknessMarker` at
  `lib/peers/marker.ts` (forward-compat — HK doesn't post to Canvas
  submission bodies today).
- Inngest cloud setup live: `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`,
  `NEXT_PUBLIC_APP_URL` set on Vercel; `transcribe-discussion` synced.
  `/api/inngest` returns 401 to unsigned GETs (correct posture).

**HK ↔ SG end-to-end is unexercised in production.** The first real
classroom recording transcribed after 2026-05-17 will fire the
outbound webhook for the first time. Diagnostics land in
`discussions.super_grader_post_status` + `super_grader_response` —
check those if SG doesn't show a Harkness card.

**M6.22 remediation — done 2026-05-22 (Phases 0 → 0b → 0c → 1 → 2 → 3).**
Six-agent audit on 2026-05-22 surfaced ~98 findings; the critical path is
closed. Full per-phase scope + reasoning in
[`REMEDIATION_PLAN.md`](./REMEDIATION_PLAN.md) and the
[`audits/`](./audits/) directory. Headline changes touching daily code:

- **Anonymizer rewritten** (`packages/anonymizer/src/index.ts`) — ports
  SG's `scrub.ts` shape (`nameVariants` covers full/first/last/hyphen-
  pieces; possessives `'s` + `'s`; Unicode word boundaries
  `(?<![\p{L}\p{N}_])`; longest-first ordering). `scrubText` + `compileRoster`
  throw typed `RosterMissingError` instead of silently no-op'ing on
  empty roster. `anonToken` enforces salt ≥ 16 bytes. 20 vitest tests.
- **Fail-closed roster contract.** `finalizeDiscussion` refuses to insert
  a discussion if `course_rosters` is missing/empty/has-no-email-students
  OR if any picked participantId lacks a usable email. Worker reads
  `discussions.roster_snapshot` (populated at finalize) and refuses to
  call Gemini if the snapshot is missing — `onFailure` writes
  `scrub_status='roster_missing'` for diagnostics.
- **Prompt-body snapshots.** `discussions.transcription_prompt_body_snapshot`
  + `summary_prompt_body_snapshot` populated at finalize; worker reads
  from snapshot. An admin edit to `/admin/prompts` during the Inngest
  delay cannot change which body Pass 1 + Pass 2 see. Sentinel for
  legacy rows (`*_body_snapshot IS NULL`) falls back to live read.
- **State fences everywhere** that touches `discussions.state`.
  `mark-transcribing` claims via `.eq('state','uploaded').select()` and
  bails on 0 rows; `save-transcript` commits Pass-1 atomically (`state=
  'transcribed'` in the same UPDATE as the transcript write); Pass-2 is
  best-effort — failures land on `summary_status='failed'+summary_error`
  WITHOUT propagating to `onFailure`; `onFailure` only clobbers
  `state IN ('uploaded','transcribing')`; SG aggregate flip fenced on
  `state='transcribed'`; `delete-discussion` is ownership-fenced +
  idempotent.
- **Per-participation SG push state.** `participations.super_grader_post_
  {status,attempted_at,error}` records per-POST outcomes — enables
  failed-only retries without parsing the aggregate JSONB.
- **Inngest event_id dedup.** `inngest.send({ id:
  'discussion-uploaded:${discussionId}', ... })` — duplicate sends within
  Inngest's window are de-duped upstream of the worker's claim.
- **Bearer compares use `crypto.timingSafeEqual`** at
  `lib/peers/auth.ts` with length pre-check + 503 when env var unset.
- **Google tokens encrypted at rest** via `lib/crypto/secret.ts`
  (AES-256-GCM; key `TEACHER_GTOKEN_ENC_KEY`). Reads encrypted-first
  with legacy plaintext fallback; refresh path nulls plaintext so rows
  converge to encrypted-only over time. `REVOKE UPDATE` on teachers from
  authenticated except `display_name` + `gemini_daily_cap`.
- **Retention sweep.** `/api/cron/sweep-discussions` daily 03:00 UTC
  (vercel.json), two state-fenced passes: archive stuck uploaded/
  transcribing >14d, hard-delete terminal-state >`RETENTION_MONTHS`
  (default 13). Storage blob FIRST, then DB row. `/admin/retention`
  surfaces counts + last-sweep audit + manual SWEEP-to-confirm trigger.
- **Sentry env-gated** (`instrumentation.ts`, `instrumentation-client.ts`,
  `lib/telemetry/sentry-init.ts`). DSN unset = no-op. `beforeSend`
  redacts likely-name shapes (allows `Student_xxxxxx` literal token),
  strips `request.query_string`. Session Replay intentionally off.
- **TargetPicker stops auto-clobbering.** `initializedBindingRef` plus
  sessionStorage persistence keyed by `(courseId, sectionId)` — polling
  refreshes no longer reset manual de-selections.
- **Recorder crash recovery.** `lib/recorder/persistence.ts` IndexedDB
  store; `MediaRecorder.ondataavailable` persists every 1s chunk
  best-effort; `beforeunload` warning during recording; RecordingFlow
  scans IDB on mount and surfaces a recovery banner for orphan
  sessions (Recover reconstitutes the Blob → Recorder renders in
  "stopped" state with audio playable; Discard clears IDB).
- **Auto-save single-flight + concurrency fence.** `useAutoSaveForm`
  queues exactly one follow-up if a save is in flight when a new
  trigger fires. `saveSystemPrompt` accepts `expected_updated_at`;
  mismatch returns `{ok:false, conflict:true}`. `AutoSaveProvider`
  aggregates per-key (`prompt:${id}`) so a quick "saved" from sibling
  editor can't green-wash another editor's error.

**Operator follow-ups still outstanding** (one-time, post-deploy):
- `openssl rand -base64 32` → Vercel + `.env.local` as
  `TEACHER_GTOKEN_ENC_KEY` (without it, new sign-ins fail to write
  encrypted Google tokens; reads keep working via plaintext fallback).
- `openssl rand -base64 32` → `CRON_SECRET` (sweep cron auths via
  Vercel-injected bearer).
- Backfill existing teachers' plaintext tokens via a one-off Node
  script (~20 lines, mirrors HAH `9a267bd` shape) — then drop the
  legacy plaintext columns.
- `curl -X PUT https://harkness-helper-v2-sgs.vercel.app/api/inngest`
  after the next deploy (suite-wide post-rename gotcha).
- (Optional) Provision Sentry project + set `SENTRY_DSN` /
  `NEXT_PUBLIC_SENTRY_DSN` to start receiving events.

**Save-to-Drive — done.** Per-row Drive menu with Save audio / Save transcript
/ Save summary / Save all to folder (folder named
`<assignment> · <section> · <date>`). Reuses the Google OAuth client shared
across the suite — Drive scopes (`drive.file`, `documents`) requested at
sign-in with `prompt=consent + access_type=offline`. Tokens stored on
`teachers.google_{access,refresh}_token` + `_expires_at`, auto-refreshed
via `googleapis` SDK when within 5min of expiry.

## Supabase project

- Project: `harkness-helper-v2` — ref `zypdhubfmbhcwarjljlp` (us-east-1)
- Dashboard: <https://supabase.com/dashboard/project/zypdhubfmbhcwarjljlp>
- 17 migrations: initial schema through `20260516170000_v1_prompts`, then
  the M6.22 remediation series (all applied 2026-05-22 via Supabase MCP):
  - `20260522120000_discussion_roster_snapshot` (Phase 0 — `roster_snapshot`
    jsonb + `scrub_status` text on `discussions`)
  - `20260522120001_rewrite_summary_prompt` (Phase 0 — drops the
    "credit students by name" instruction)
  - `20260522130000_teacher_gtoken_encryption` (Phase 0b —
    `teachers.google_*_encrypted` text columns alongside legacy plaintext)
  - `20260522130001_tighten_teachers_update_rls` (Phase 0b — REVOKE
    UPDATE on teachers + GRANT UPDATE(display_name, gemini_daily_cap))
  - `20260522140000_retention_archived_state` (Phase 0c —
    `discussion_state += 'archived'`)
  - `20260522140001_retention_audits` (Phase 0c — audit log table)
  - `20260522150000_discussion_prompt_snapshots` (Phase 1 —
    `transcription_prompt_body_snapshot` + `summary_prompt_body_snapshot`)
  - `20260522160000_state_fences_and_partial_success` (Phase 2 —
    `discussions.summary_status` + `summary_error` for partial-success
    policy; `participations.super_grader_post_*` for per-participant
    push state)
- `discussions` composite unique on (canvas_assignment_id, canvas_section_id)
  NULLS NOT DISTINCT so two sections of the same Canvas assignment can each
  have a recording.
- Seeded system prompts (purposes: `transcription`, `summary`,
  `speaker_identification`, `individual_feedback`). The last two are seeded
  but not yet called by the pipeline — placeholders for future per-student
  flow.

## Stack

- pnpm monorepo: `apps/web` (Next 16, App Router) +
  `packages/{db,anonymizer,canvas,prompts}`
- Supabase (Postgres + Auth via `@supabase/ssr` cookies, Google SSO
  restricted to `episcopalhighschool.org`)
- Vercel hosting, Inngest v4 for the transcription job
- Gemini 2.5 Flash for transcription + summary (Standard tier; key shared
  across the suite per the converged 2026-05-15 setup)
- googleapis SDK for Drive + Docs

## Conventions mirrored from AI Documenter v2

- Three Supabase clients in `@harkness-helper/db`: `browser` (publishable
  key), `server` (cookie-aware), `admin` (service role).
- SECURITY DEFINER RLS helpers (`is_teacher_owner`, `is_admin`) are
  `EXECUTE`-granted to `authenticated`.
- Admin layer: `admins` table, `INITIAL_ADMIN_EMAIL` self-bootstrap,
  last-admin-lockout guard.
- Unified `/auth/callback` exchanges code → session, captures Google
  provider tokens, upserts the teacher row.
- The Next 16 proxy refreshes the Supabase session per request and
  optimistically gates `/dashboard/*` + `/admin/*`.

## Gotchas worth remembering

- **Don't POST the audio Blob through a Server Action.** Next.js caps
  Server Action request bodies at 1 MB by default; Vercel's serverless
  ceiling is ~4.5 MB regardless of plan. Anything past a couple minutes
  of recording threw `Body exceeded 1mb limit` as an unhandled exception
  → 400 with "Uncaught Exception" in Vercel logs, before the action's
  code ever ran. Fixed 2026-05-20 by splitting upload into
  `prepareDiscussionUpload` (issues a Supabase signed upload URL) +
  client `fetch(PUT, signedUrl, blob)` + `finalizeDiscussion`
  (metadata-only). The blob never crosses Next.js — bucket's 100 MB
  `file_size_limit` is the real ceiling. If you add another media-upload
  flow to this app or any sibling, default to this pattern; do NOT
  shoulder bytes through a Server Action even "just for now."
- **`GEMINI_API_KEY` in shell shadows .env.local.** Gemini CLI writes
  `export GEMINI_API_KEY="$(cat ~/.gemini-api-key)"` to `~/.zshrc`.
  Next.js's env load order puts shell env above .env files. Fixed in
  `package.json`'s dev/build/start by wrapping with
  `env -u GEMINI_API_KEY <next cmd>`. See suite-level CLAUDE.md for the
  full diagnostic story.
- **`@google/genai@2.3.0` Files API auth path is questionable.** Bypassed
  with raw fetch on diagnosis day, then REVERTED when the env-shadow turned
  out to be the real cause. The SDK path may still have issues; if Files
  uploads start failing in the future, recheck.
- **Inngest v4 `createFunction` signature changed.** Triggers go inside the
  config object now (one arg vs the v3 two-arg form).
  `createFunction({id, triggers: [...], retries, onFailure}, handler)`.
- **`INNGEST_DEV=1` required for local dev.** Without it, v4 SDK assumes
  cloud mode and the `/api/inngest` route 500s with "no signing key found."
- **OAuth refresh tokens are only returned on FIRST consent.** If a sibling
  app on the same Google OAuth client already granted these scopes, Google
  silently re-issues the access token but NOT the refresh token. Login route
  uses `prompt=consent` to force re-prompt and guarantee refresh-token
  return.
- **Gemini Files API does NOT accept `audio/webm`.** Accepted MIME types:
  wav / mp3 / aiff / aac / ogg / flac / m4a. MediaRecorder mime preference
  in the recorder picks `audio/mp4` first; if a browser only supports
  webm/opus, transcription fails with a clear error.
- **`router.refresh()` polling regenerates signed URLs.** During the
  ~30-60s transcription window, the inline audio player may interrupt
  playback. Polling stops as soon as state is terminal.

## Setup (already done; reference for next clone)

```sh
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill in all env vars
supabase db push                                # or Supabase MCP apply_migration
pnpm dev                                        # apps/web at http://localhost:3000
npx inngest-cli@latest dev                      # in another terminal — port 8288
```

First sign-in: log in with the email set as `INITIAL_ADMIN_EMAIL`
(byte-exact match against your Workspace email). Auto-promoted to admin on
first visit to `/admin`. From there, grant other admins via `/admin/admins`.

Env vars (all in `.env.example`):
- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (same converged
  OAuth client as the rest of the suite)
- Admin bootstrap: `INITIAL_ADMIN_EMAIL`, `ADMIN_EMAIL_DOMAIN`
- Gemini: `GEMINI_API_KEY` (per-app — HK has its own), `GEMINI_DEFAULT_DAILY_CAP`
- Inngest: `INNGEST_DEV=1` (local) OR `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` (prod)
- Canvas: per-teacher tokens on `teachers.canvas_token_encrypted` +
  `teachers.canvas_host`, encrypted with `TEACHER_GTOKEN_ENC_KEY` (shared
  with `google_*_encrypted` per Phase 0b). Set via `/dashboard/setup` →
  Connect Canvas. No env vars to configure.
- Suite peer integration (live as of Phase D): `SUPER_GRADER_SALT`,
  `SUPER_GRADER_API_URL`, `SUPER_GRADER_INGEST_TOKEN`, `HARKNESS_API_TOKEN`,
  `NEXT_PUBLIC_APP_URL`
- M6.22 Phase 0b — at-rest Google-token encryption: `TEACHER_GTOKEN_ENC_KEY`
  (`openssl rand -base64 32`; required for new sign-ins to write encrypted
  tokens; reads continue to work via plaintext fallback when unset)
- M6.22 Phase 0c — retention sweep: `CRON_SECRET` (Vercel-injected bearer
  for `/api/cron/sweep-discussions`), `RETENTION_MONTHS` (default 13)
- Sentry (optional): `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`
