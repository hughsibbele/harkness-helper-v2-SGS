# Harkness Helper v2

Next.js 16 + Supabase rewrite of the Apps Script v1 in the parent directory.
v1 stays running until v2 is proven on a real classroom recording.

Scope, phases, and design specs live in [`CLAUDE.md`](./CLAUDE.md) and in
[super-grader's `planning/harkness-helper-v2.md`](../../Super%20Grader/planning/harkness-helper-v2.md).

## Stack

pnpm monorepo · Next.js 16 (`apps/web`) · Supabase (Postgres + Auth via
`@supabase/ssr` cookies) · Gemini 2.5 Flash · Inngest (Phase C+) · Vercel.

## Setup

```sh
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill in values; see Secrets below
supabase db push                                # run migrations against your Supabase project
pnpm dev                                        # starts apps/web on http://localhost:3000
```

## Secrets

> **Policy: `.env.example` is the canonical source of truth.** If you add a
> new env var in code, add it to `apps/web/.env.example` in the same PR. If
> you rename one on Vercel, rename it there too. When the two disagree,
> `.env.example` wins — Vercel and code should be brought in line, not the
> other way around.

### Shared-ecosystem secrets

HH v2 is one of several "satellite" tools that integrate with the Super
Grader project. Some secret *values* are **shared** across projects, but
each project names them after who it's talking to.

| Value | Where it lives | What it does |
|---|---|---|
| **Anonymization salt** | `SUPER_GRADER_SALT` in **HH**, **Super Grader**, **AI Documenter**, **Handwritten Helper**, **Oral Examiner v2** | HMAC salt for the `anon_token`s. Same name everywhere. Never regenerate — invalidates every stored token across all peers. |
| **HH inbound bearer** | `HARKNESS_API_TOKEN` in both **HH** and **Super Grader** | Same name on both sides. HH accepts requests carrying this bearer; Super Grader presents it on outbound GETs to `/api/super-grader/*`. |
| **HH outbound bearer** | `SUPER_GRADER_INGEST_TOKEN` in **HH**, but `HARKNESS_INGEST_TOKEN` in **Super Grader** | Asymmetric: we name after who we're authing TO; SG names after who's authing IN. Same value, two perspectives. |
| **Gemini API key** | `GEMINI_API_KEY` everywhere | One key, central billing, same name in every project. |

**Mental model.** The name on **your side** describes who **you** are talking
to. The name on **the other side** describes who **they** are listening to.
That's why the same bearer is `SUPER_GRADER_INGEST_TOKEN` in HH (the token I
present to Super Grader) and `HARKNESS_INGEST_TOKEN` in Super Grader (the
token I expect from Harkness Helper).

### Cross-project setup order

When provisioning a fresh deployment, set secrets in this order to avoid
"why is the other tool 401-ing me?" debugging:

1. `SUPER_GRADER_SALT` — copy from a sibling project's env (don't regenerate).
2. Inbound bearer (`HARKNESS_API_TOKEN`) — generate fresh, set on both this
   project and Super Grader.
3. Outbound bearer (`SUPER_GRADER_INGEST_TOKEN` here = Super Grader's
   `HARKNESS_INGEST_TOKEN`) — generate fresh, set on both sides.
4. `SUPER_GRADER_API_URL` — set once super-grader has a URL.

### When you add a new secret

1. Add the var to `apps/web/.env.example` with a comment explaining what
   it is, where to get the value from, and what happens if it's missing
2. Read it via `process.env.VAR_NAME`; fail loudly when required and unset
3. Run `vercel env add VAR_NAME production` (and `preview`, `development`
   if the value differs across environments)
4. If shared with another project in this ecosystem, update both sides +
   the cross-project mapping above
