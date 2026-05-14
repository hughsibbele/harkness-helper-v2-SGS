# Harkness Helper v2

Next.js 16 + Supabase rewrite of the Apps Script v1 in the parent directory. v1 stays running until v2 is proven on a real classroom recording.

Plan: `/Users/hughkoeze/Code/Super Grader/planning/harkness-helper-v2.md`

## Current state — 2026-05-14

**Phase A shipped and verified end-to-end.** Hugh signed in via Google SSO, auto-promoted to admin, edited the seeded transcription prompt. The full chain (auth → cookie session → RLS → admin gate → service-role write) is working against the live Supabase project.

Up next: Phase B (Canvas API client + cache sync, then upload form + browser recorder).

## Supabase project

- Project: `harkness-helper-v2` — ref `zypdhubfmbhcwarjljlp` (us-east-1)
- Dashboard: <https://supabase.com/dashboard/project/zypdhubfmbhcwarjljlp>
- Migrations applied: `initial_schema`, `admins_and_prompts`, `canvas_cache`, `gemini_rate_limits`
- 10 tables; seeded with one `(scope=system, purpose=transcription, is_default=true)` prompt
- Hugh's admin row: `hkoeze@episcopalhighschool.org` (created via `INITIAL_ADMIN_EMAIL` bootstrap on first visit to `/admin`)

## Stack

- pnpm monorepo: `apps/web` (Next 16, App Router) + `packages/{db,anonymizer,prompts}`
- Supabase (Postgres + Auth via `@supabase/ssr` cookies, Google SSO restricted to `episcopalhighschool.org`)
- Vercel hosting, Inngest for background transcription jobs (added in Phase C)
- Gemini 2.5 Flash for audio transcription (Standard tier)

## Conventions mirrored from AI Documenter v2

- Three Supabase clients in `@harkness-helper/db`: `browser` (publishable key), `server` (cookie-aware, for server components + actions + route handlers), `admin` (service role, bypasses RLS).
- SECURITY DEFINER RLS helpers (`is_teacher_owner`, `is_admin`) are `EXECUTE`-granted to `authenticated` — revoking breaks policy evaluation silently.
- Admin layer: `admins` table keyed on email, `INITIAL_ADMIN_EMAIL` env self-bootstraps the first admin on login when the table is empty, last-admin-lockout guard on revoke.
- Prompts table uses `scope ∈ {system, teacher}` × `purpose ∈ {transcription, …}`. Transcription prompts must be `scope='system'` (school policy, not per-teacher).
- Unified `/auth/callback` route exchanges code → session, upserts the teacher row, redirects.
- The Next 16 proxy (`src/proxy.ts`) refreshes the Supabase session on every request and optimistically gates `/dashboard/*` + `/admin/*`. Real authorization happens close to data in `getCurrentTeacher` / `getCurrentAdminEmail`.
- Asymmetric peer-token naming: each project labels its peer's secrets after **who it's talking to**. HH holds `SUPER_GRADER_INGEST_TOKEN` (outbound) + `HARKNESS_API_TOKEN` (inbound); super-grader holds the same byte-values under `HARKNESS_INGEST_TOKEN` + `HARKNESS_API_TOKEN`.

## Phase A — shipped 2026-05-14

- Monorepo skeleton + 4 Supabase migrations applied
- Google SSO + workspace domain gate, shared OAuth client across all five EHS Supabase projects
- `/dashboard` placeholder + `/admin` shell with dark-blue header rule to distinguish admin sessions
- `/admin/prompts` — single-prompt editor for the seeded transcription prompt
- `/admin/admins` — grant/revoke with last-admin-lockout guard

## Phase B — next

- `packages/canvas` — paginated fetch helpers (`getCourses`, `getAssignmentsForCourse`, `getRosterForCourse`)
- `apps/web/src/lib/actions/canvas-sync.ts` — server action → upsert to `canvas_course_cache`, `canvas_assignment_cache`, `course_rosters`
- `/admin/sync` (or `/dashboard/sync`) — manual "Refresh" button + last-synced timestamps
- Active-term filter on the course picker (derive current term from today's date)
- Browser audio recorder component (MediaRecorder API; pause/resume; MP3/M4A export)
- Upload form: course → assignment → audio → participants → Supabase Storage + `discussions` row

## Out of scope (later phases)

- Phase C: Inngest transcription job, rate-limit gate, boundary scrubber
- Phase D: webhook to super-grader's `/api/ingest/harkness`, prompt pull endpoint for super-grader
- Phase E: Sentry, retention panel, re-push button, audio length cap

## Setup (already done; reference for next clone)

```sh
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill in Supabase + Google envs
supabase db push                                # or use the Supabase MCP apply_migration tool
pnpm dev                                        # starts apps/web on http://localhost:3000
```

First sign-in: log in with the email you set as `INITIAL_ADMIN_EMAIL` (byte-exact match against your Workspace email — case-sensitive on the prefix). That user is auto-promoted to admin on first visit to `/admin`. From there, grant other admins via `/admin/admins`.
