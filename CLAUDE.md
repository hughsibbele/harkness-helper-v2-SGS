# Harkness Helper v2

Next.js 16 + Supabase rewrite of the Apps Script v1 in the parent directory. v1 stays running until v2 is proven on a real classroom recording.

Plan: `/Users/hughkoeze/Code/Super Grader/planning/harkness-helper-v2.md`

## Status

See [`../BUILD_PLAN.md`](../BUILD_PLAN.md) for ecosystem-wide milestones and current state. M2a covers the remaining Harkness work (Canvas client + cache, audio recorder, upload form, Inngest transcription, super-grader webhook + prompt-pull endpoint).

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

## Setup (already done; reference for next clone)

```sh
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill in Supabase + Google envs
supabase db push                                # or use the Supabase MCP apply_migration tool
pnpm dev                                        # starts apps/web on http://localhost:3000
```

First sign-in: log in with the email you set as `INITIAL_ADMIN_EMAIL` (byte-exact match against your Workspace email — case-sensitive on the prefix). That user is auto-promoted to admin on first visit to `/admin`. From there, grant other admins via `/admin/admins`.
