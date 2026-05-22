# HH PII-scrubbing + audio↔transcript boundary + Gemini call surfaces

Audit date: 2026-05-22. Auditor: Claude (Opus 4.7, 1M ctx).
Scope (M6.22): theme #2 of six parallel HH audits. Focuses exclusively on
the anonymizer-token computation, the roster-driven free-text scrubber,
the audio→transcript→summary→DB pipeline, and the outbound super-grader
webhook PII surface. Adjacent themes (state machine fences, Canvas integ,
auto-save, cross-system seams, auth/storage/setup) are owned by sibling
audits.

Files actually read:

- `packages/anonymizer/src/index.ts`
- `apps/web/src/lib/inngest/transcribe-discussion.ts`
- `apps/web/src/lib/peers/envelope.ts`
- `apps/web/src/lib/peers/notify.ts`
- `apps/web/src/lib/peers/types.ts`
- `apps/web/src/lib/peers/auth.ts`
- `apps/web/src/lib/peers/marker.ts`
- `apps/web/src/lib/super-grader/scope.ts`
- `apps/web/src/lib/actions/upload-discussion.ts`
- `apps/web/src/lib/actions/canvas-sync.ts`
- `apps/web/src/lib/actions/save-to-drive.ts`
- `apps/web/src/lib/actions/system-prompts.ts`
- `apps/web/src/app/api/super-grader/result/route.ts`
- `apps/web/src/app/api/super-grader/prompt/route.ts`
- `apps/web/src/app/dashboard/page.tsx`
- `apps/web/src/app/dashboard/DiscussionList.tsx`
- `apps/web/src/app/dashboard/SaveToDriveMenu.tsx` (listing only)
- `packages/prompts/src/index.ts`
- `supabase/migrations/20260513120000_initial_schema.sql` (relevant table defs)
- `supabase/migrations/20260513120001_admins_and_prompts.sql` (transcription seed)
- `supabase/migrations/20260516170000_v1_prompts.sql` (summary + speaker_id + individual_feedback seeds)
- Cross-reference: `super-grader-v2-SGS/planning/integration-contract.md` §2/§3
- Cross-reference: `super-grader-v2-SGS/packages/anonymizer/src/{token.ts,scrub.ts}`

Reference root causes (from M6.19/20/21 OE+AID+HAH audits):

1. No snapshot semantics — live FK reads at confirm/transcribe time.
2. No state fences on UPDATEs.
3. No transactional boundaries across subsystems.
4. **Fail-open instead of fail-closed** — when roster lookup or scrub
   fails, the pipeline writes the un-scrubbed transcript anyway.
5. No retry/idempotency on user-visible mutations.

---

## Bug map (TL;DR)

| #  | Severity | One-line                                                                                         |
|----|----------|--------------------------------------------------------------------------------------------------|
| 1  | CRITICAL | Empty/missing roster → `scrubText` no-ops silently, but the pipeline writes the un-scrubbed Gemini output to `discussions.transcript` + `discussions.summary` anyway. Same fail-open shape that bit OE/AID/HAH. |
| 2  | CRITICAL | Roster-row missing OR roster fetch error → caught and converted to empty roster, then proceeds. The whole transcript persists un-scrubbed. Pure root-cause #4. |
| 3  | CRITICAL | `scrubText` does **whole-name-only** matching (`\b<full_name>\b`). The audio is full of "Sarah", "Liz", "Mr. Smith" — first-name-only, last-name-only, nicknames, and possessives ("Sarah's") all pass through to the DB and out to super-grader unscrubbed. Major drift from SG's `nameVariants` + `(?:['’]s)?` scrubber. |
| 4  | CRITICAL | Pass-2 summary prompt explicitly instructs Gemini "Credit specific students by name for notable contributions" while pass-1 instructs it to use `Student_xxxxxx`. The two prompts disagree about anonymization, so the moment a real name slips through pass 1 (Finding 3), pass 2 actively amplifies and propagates it. |
| 5  | HIGH     | Token computation cannot detect drift — HH does not enforce a minimum salt length (SG enforces ≥16 bytes). A misconfigured `SUPER_GRADER_SALT=foo` produces a deterministic-but-different token from every other satellite, looking valid but joining wrong cross-app. |
| 6  | HIGH     | `students.anon_token` is computed **at upload time** from the in-process `anonToken()`, then **read back at envelope-build time** for outbound webhook + GET. If the salt rotates or the env var temporarily drops between upload and envelope-build, the outbound `anon_token` no longer matches what HH would compute today — but HH never re-derives or audits this. |
| 7  | HIGH     | `pushDiscussionToSuperGrader` is fail-open on transient SG outages by design, but on a **complete** failure (no participants, no envelope) it writes status='error' with the **error message** stored in `super_grader_response.failed[].error` — and that message may contain DB error text or PII fragments from the join. Today's call sites produce sanitized strings, but the contract is "any throw lands here" which is brittle. |
| 8  | HIGH     | Roster snapshot is loaded **at transcribe time** (`transcribe-discussion.ts:120-151`), not at upload time. A student added/removed between `finalizeDiscussion` and the Inngest worker run uses the wrong roster for scrubbing. Identical to root-cause #1 from the audit brief. |
| 9  | MEDIUM   | The audio signed URL (1 hour TTL) is the only egress where Gemini sees raw spoken student names. This is the unavoidable boundary — but it is **not documented** in CLAUDE.md or anywhere else as the intentional privacy posture. Audit liability without a written record. |
| 10 | MEDIUM   | `prompts` table is admin-editable. The transcription prompt's "anonymize names" clause is the only barrier between Gemini's verbatim transcript and a real-name leak. `saveSystemPrompt` has zero safeguards against an admin accidentally weakening that clause. |
| 11 | MEDIUM   | `course_rosters.students` JSONB schema is implicit (no DB-side check). `transcribe-discussion.ts:132-143` filters to `email: string` rows but doesn't validate `name` shape — a malformed roster row (empty `name`) becomes a noisy regex that may scrub unrelated content. |
| 12 | MEDIUM   | `discussions.audio_url` is a storage path stored unencrypted. Combined with `participations` join, that path identifies "this is Sarah Smith's spoken voice." Bucket is private, but the discussion row leaks the linkage by canvas_user_id. (Acceptable — flagged because the audio bytes are the most sensitive PII in the suite.) |
| 13 | LOW      | Anonymizer scrubber drift vs SG: ASCII `\b` instead of Unicode `\\p{L}` boundary, no possessive matching, no first-name/last-name variants, no structured-fields scrubber. Detail in Finding 3. |
| 14 | LOW      | Zero tests under `packages/anonymizer/`. No tests anywhere in HH. The fail-open shape in Findings 1+2 would be locked in by a test that asserts "empty roster → text unchanged" (= "scrub is a no-op when roster empty"). |
| 15 | LOW      | `result/route.ts` returns the same signed audio URL as the outbound webhook with same 1h TTL. SG is on the EHS side of the boundary, so this is intended — but the URL is unauthenticated for an hour once issued. If SG's response or logs leak the URL, the audio is recoverable. |

---

## Finding 1 — CRITICAL: Empty roster collapses scrub to a no-op; pipeline still persists the Gemini output

**Severity:** Critical. Same fail-open shape that bit OE/AID/HAH.

**Files / lines:**
- `packages/anonymizer/src/index.ts:50-64` (`scrubText`)
- `apps/web/src/lib/inngest/transcribe-discussion.ts:120-151` (roster fetch)
- `apps/web/src/lib/inngest/transcribe-discussion.ts:212-227` (`scrub-transcript` → `save-transcript`)

**Trace:**

1. `transcribe-discussion.ts:125-130` looks up the roster:
   ```ts
   const { data: rosterRow, error: rosterErr } = await admin
     .from("course_rosters")
     .select("students")
     .eq("teacher_id", discussion.teacher_id)
     .eq("canvas_course_id", discussion.canvas_course_id)
     .maybeSingle();
   ```
2. `maybeSingle()` returns `data=null, error=null` when no row exists for
   that course (legitimate case: teacher never ran a Canvas sync, or this
   `canvas_course_id` lives outside the `course_rosters` snapshot due to
   a sync gap).
3. `transcribe-discussion.ts:131` only throws if `rosterErr` is truthy.
   When the row is missing, `rosterRow` is `null`, the next lines compute:
   ```ts
   const rosterStudents: RosterStudent[] = Array.isArray(rosterRow?.students)
     ? (rosterRow.students as RosterStudent[])
     : [];
   ```
   → `rosterStudents = []` → `roster = []`.
4. `scrub-transcript` step at line 212-214 calls
   `scrubText(rawTranscript, [])`.
5. `scrubText` at `index.ts:54-63`:
   ```ts
   let out = text;
   const sorted = [...roster].sort((a, b) => b.name.length - a.name.length);
   for (const s of sorted) { ... }
   return out;
   ```
   With `roster = []` the for-loop body never runs. `out === text`. The
   raw Gemini transcript — which **may contain student names** if Gemini
   ignored the prompt's "anonymize names" clause — is returned unchanged.
6. `save-transcript` step at line 218-227 writes `scrubbedTranscript`
   (= raw Gemini output, unchanged) to `discussions.transcript`.
7. Pass 2's summary prompt receives this same unchanged text. The
   summary's `scrub-summary` step at line 252-257 is also a no-op.
8. `pushDiscussionToSuperGrader` reads `discussions.transcript` and
   `discussions.summary` verbatim into the envelope (`envelope.ts:94-97`)
   and POSTs to SG. SG ingests un-scrubbed transcript bytes.

**What bytes cross which boundary:**

- Gemini's verbatim transcript (pass 1 output) may contain `"Sarah Smith"`
  literal if Gemini partially ignored the anonymize-names instruction.
- That string is **written to `discussions.transcript` in HH's Postgres**
  unscrubbed.
- It is **read back into the envelope** at `envelope.ts:96` and sent over
  the wire to SG via `notify.ts:135-143`.
- It is **rendered to the teacher's screen** via `DiscussionList.tsx`
  (which currently doesn't render the body — but the M6.22 sibling audit
  for state machine notes the dashboard could surface transcripts).
- It is **handed to Drive** in `save-to-drive.ts:172` via `createDoc` if
  the teacher clicks Save Transcript.

**Why this matches the OE/AID/HAH bug shape:**

The audit brief specifically calls out fail-open: "when roster lookup or
scrub fails, the pipeline writes the un-scrubbed transcript anyway."
HH's variant has three reinforcing layers:
- The Supabase query (line 125-130) uses `maybeSingle()`, so a missing
  row is `data=null, error=null` — not an error.
- The roster array fallback (line 132-134) silently swaps `null` for `[]`.
- The scrubber (`index.ts:54-63`) treats an empty roster as "nothing to
  do, return text unchanged" instead of refusing.

Three independent points where fail-closed could have been chosen, all
three chose fail-open. The seeded transcription prompt's
"anonymize names" clause is the **only** thing standing between Gemini's
verbatim audio transcription and a real-name leak. LLM instruction-
following is best-effort, not enforcement.

**Fix direction:**

1. In `transcribe-discussion.ts:120-151`, replace silent fallback with
   fail-closed: if `rosterRow` is null OR `rosterStudents.length === 0`,
   **throw** with a clear message. `onFailure` marks state=`failed` and
   surfaces the cause to the teacher. Better to refuse than to leak.
2. In `packages/anonymizer/src/index.ts:50`, refuse an empty roster:
   ```ts
   export function scrubText(text, roster) {
     if (!roster || roster.length === 0) {
       throw new Error(
         "scrubText: empty roster. Refusing to claim a scrub happened.",
       );
     }
     ...
   }
   ```
   This makes it impossible for any future caller to silently no-op.
3. Add tests asserting both fail-closed behaviors (Finding 14).
4. (Defense-in-depth) After writing the scrubbed transcript, re-scan with
   a generic name detector (e.g., `\b[A-Z][a-z]+\b` heuristic) and fail
   the function if any candidate name remains. Last-resort net.

---

## Finding 2 — CRITICAL: Roster lookup error path is the same as missing row

**Severity:** Critical. Subset of Finding 1 but a distinct mechanism.

**Files / lines:**
- `transcribe-discussion.ts:131`

```ts
if (rosterErr) throw new Error(`roster lookup: ${rosterErr.message}`);
```

This is **the only** error handling on the roster query. The code does
correctly throw when Supabase returns an explicit error. But a quirk: if
the Supabase client returns `{ data: null, error: null }` for any reason
that doesn't quite count as an error (RLS denial silently filtered to
zero rows, a transient connection issue that doesn't surface as an
exception, etc.), the code falls into the `else []` branch at line 132
and proceeds with empty roster.

Note: this code path runs as the admin (service-role) client, so RLS
denial isn't the threat model here. The real threats:
- A teacher whose course-roster row genuinely doesn't exist (never synced
  Canvas, or synced before the `course_rosters` table existed).
- A foreign-key mismatch where `discussion.canvas_course_id` doesn't
  match any `course_rosters.canvas_course_id` (typo, manual data fix-up,
  course renumbered in Canvas).
- A future case where the query returns 0 rows for any reason (corrupt
  data, partial migration, etc.).

All three collapse to "empty roster → no scrub → un-scrubbed write."

**Fix direction:** same as Finding 1.

---

## Finding 3 — CRITICAL: Whole-name-only matching misses every first-name utterance

**Severity:** Critical. This is the most-likely-to-actually-leak path.

**Files / lines:**
- `packages/anonymizer/src/index.ts:50-64`

**Code:**
```ts
const escaped = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(`\\b${escaped}\\b`, "gi");
out = out.replace(re, token);
```

Where `s.name` is `display_name` from the roster, typically
`"Sarah Smith"` (first + last with one space).

**What this matches:**
- `"Sarah Smith"` — literal full name.
- (case-insensitive) `"sarah smith"`, `"SARAH SMITH"`.

**What it misses:**
- `"Sarah"` (first name only) — the most common form in Harkness audio.
  Teachers call on students by first name. Other students reply by
  first name. The transcript will be dense with first names.
- `"Smith"` (last name only) — "Mr. Smith", "what Smith said earlier".
- `"Sarah's"` — possessive, both straight and curly apostrophe.
- `"Smith-Jones"` hyphenated names — only matches the full hyphenated form;
  doesn't match each piece individually.
- Nicknames not in the roster: "Liz" when roster has "Elizabeth", "Bob"
  when roster has "Robert", "Sam" when roster has "Samuel". The roster
  scrubber has no canonical-name expansion.
- Phonetic spellings / Gemini transcription errors: roster has "Sara",
  Gemini transcribes "Sarah" (or vice versa). One-character difference,
  not matched.

**Why this matters in HH specifically:**

The pass-1 prompt asks Gemini to anonymize names to `Student_xxxxxx`.
This is best-effort. When Gemini partially complies (anonymizes the
introductions but lets a first-name slip later), the scrubber's job is
the safety net. With whole-name-only matching, the safety net catches
nothing.

The pass-2 summary prompt then receives the partly-anonymized transcript
and is **explicitly told** to "Credit specific students by name." If
Gemini sees `"Student_abc123 made the point that..."` it credits the
token (good). But if Gemini sees `"Sarah made the point that..."` slipped
through pass 1, pass 2 credits "Sarah" verbatim and that name lands in
the summary too.

**Drift from SG's scrubber:**

SG's `packages/anonymizer/src/scrub.ts` is correct here:
- `nameVariants()` at line 21-52 generates full, first-only, last-only,
  and per-hyphen-piece variants.
- Each variant matches with optional `(?:['\\u2019]s)?` possessive.
- Boundary is Unicode-aware: `(?<![\\p{L}\\p{N}_])` lookbehind, not ASCII
  `\b`.
- Compiles a regex per variant, sorted longest-first, applied serially.

HH's scrubber has none of these.

**What bytes leak today:**

- Audio of a 50-minute Harkness discussion → Gemini transcript → DB.
- Gemini's transcript is mostly anonymized (the prompt is followed
  most of the time) but contains an average of N first-name utterances
  that slipped through.
- HH's scrubber matches zero of them (because none are in `Sarah Smith`
  full-name form).
- All N first-name utterances land in `discussions.transcript`,
  `discussions.summary`, and the SG envelope.

**Fix direction:**

Port SG's `nameVariants` + Unicode-boundary + possessive logic into
`@harkness-helper/anonymizer`. Or — better — make `@harkness-helper/
anonymizer` re-export `@super-grader/anonymizer` once the M5 consolidation
lands. The drift between identically-named-but-different scrubbers across
the suite is the architectural smell.

Until M5: lift `scrub.ts` from SG into HH verbatim. ~80 lines.

---

## Finding 4 — CRITICAL: Summary prompt actively asks Gemini to use real names

**Severity:** Critical (interacts with Finding 3 to amplify leaks).

**Files / lines:**
- `supabase/migrations/20260516170000_v1_prompts.sql:38` (seeded summary prompt body)
- `transcribe-discussion.ts:233-250` (`gemini-summarize` call)

**The seeded summary prompt (excerpt):**
```
2. **The Good**: Highlight 2-3 specific positive achievements. Credit
   specific students by name, linking them to their idea or contribution.
...
- Credit specific students by name for notable contributions.
```

This is v1's `GROUP_FEEDBACK` prompt verbatim — preserved for parity, but
the suite's privacy posture has moved on. v1 ran in a different threat
model (no super-grader, no cross-system data flow).

**The data flow:**

1. Pass 1 (`gemini-transcribe`) is told: "If any student's name is spoken
   in the audio, replace it in your output with the literal token
   `Student_xxxxxx`."
2. Pass 1's output is scrubbed (no-op if Finding 1/2/3 trigger).
3. Pass 2 (`gemini-summarize`) is told: "Credit specific students by
   name for notable contributions."
4. If pass 1 fully anonymized, pass 2 sees `Student_abc123` and credits
   the token. Output is harmless.
5. If pass 1 partially anonymized (e.g., "Sarah introduced the idea
   that...") and the scrubber missed the first-name utterance (Finding
   3), pass 2 sees the real name AND is **explicitly instructed** to
   propagate it. The output summary contains `"Sarah was particularly
   strong on..."`.

The two prompts have **contradictory anonymization stances**. Pass 1
tries to remove names; pass 2 tries to surface them. The scrubber sits
between them as the supposed normalizer, but Finding 3 means it doesn't
do that job.

**What bytes cross which boundary:**

- The summary prompt body itself doesn't contain real PII (it's a
  template).
- But the prompt **instructs Gemini to surface PII**, which is unusual
  for a system prompt in the FERPA-sensitive context.
- The summary output is written to `discussions.summary` and shipped
  to SG via `envelope.ts:97`.

**Fix direction:**

Rewrite the summary prompt to say "Credit specific students by their
`Student_xxxxxx` token, linking them to their idea or contribution" —
matching the contract that the transcript Gemini sees is already
anonymized. Single-line prompt edit. Won't fix Finding 3 by itself, but
removes the active amplification.

Add to `system-prompts.ts` an admin-side safeguard that warns (or
refuses) saves to the summary prompt that mention "by name" or "real
name". Defense-in-depth.

---

## Finding 5 — HIGH: Token computation doesn't enforce salt-length floor

**Severity:** High (silent token drift across satellites).

**Files / lines:**
- `packages/anonymizer/src/index.ts:14-34`
- compare to `super-grader-v2-SGS/packages/anonymizer/src/token.ts:17-29`

**HH code:**
```ts
const salt = process.env.SUPER_GRADER_SALT;
if (!salt) {
  throw new Error("anonymizer: SUPER_GRADER_SALT is not set. ...");
}
...
.createHmac("sha256", Buffer.from(salt, "base64"))
```

**SG code (same package, different repo):**
```ts
const saltBytes = Buffer.from(salt, "base64");
if (saltBytes.length < 16) {
  throw new Error(
    `anonymizer: salt is suspiciously short (${saltBytes.length} bytes after base64 decode). ` +
      `Generate at least 32 bytes.`,
  );
}
```

A `SUPER_GRADER_SALT=foo` env var (a typo, a placeholder, a "I'll fix
this later" filler) produces a valid HMAC output in HH — just not the
output any other satellite would produce given the same canvas_user_id
+ email. The token is deterministic-but-wrong: two HH-side computations
agree with each other, but disagree with every other satellite's
computation for the same student.

**What bytes cross which boundary:**

- HH writes `students.anon_token = "Student_aabbcc"` (computed with bad
  salt) for canvas_user_id=12345.
- AID/OE/HAH compute `"Student_xxyyzz"` (different value) for the same
  student because they have the correct salt.
- SG joins by `anon_token` across satellites. Same student looks like
  two different students. Card-rendering fails (HH card never appears
  for this student in SG, because SG indexed by AID's/OE's token).

**Token-byte-equivalence verification:** assuming the salt is correct,
HH's algorithm is **byte-identical** to SG's:
```
input = "ehs\0" + canvas_user_id + "\0" + email_lowercased
salt  = base64-decoded SUPER_GRADER_SALT
mac   = HMAC-SHA256(salt, input)
token = "Student_" + mac.slice(0, 6)
```
Email is `.trim().toLowerCase()`. canvas_user_id is `String(...)`. ehs
prefix has the `\0` byte. All match `super-grader-v2-SGS/planning/
integration-contract.md` §2 byte-for-byte. **No drift in the algorithm
itself.**

The drift is only operational: HH skips the safety check that SG enforces.

**Fix direction:**

Lift the SG check verbatim:
```ts
const saltBytes = Buffer.from(salt, "base64");
if (saltBytes.length < 16) {
  throw new Error(
    `anonymizer: salt is suspiciously short (${saltBytes.length} bytes after base64 decode). ` +
      `Generate at least 32 bytes.`,
  );
}
```

Or — pending M5 consolidation — make `@harkness-helper/anonymizer`
just re-export `@super-grader/anonymizer`. Eliminates this category of
drift by construction.

---

## Finding 6 — HIGH: anon_token is computed at upload time, used at envelope-build time, never re-derived

**Severity:** High (latent salt-rotation hazard).

**Files / lines:**
- `apps/web/src/lib/actions/upload-discussion.ts:116` (`anonToken(cuid, r.email)` at upload time)
- `apps/web/src/lib/peers/envelope.ts:49` (`students.anon_token` read at envelope-build time)
- `supabase/migrations/20260513120000_initial_schema.sql:42` (`anon_token text not null`)

**The flow:**

1. Teacher uploads a recording. `finalizeDiscussion` at
   `upload-discussion.ts:106-119` iterates participant Canvas user IDs,
   looks up each in the roster snapshot (in-process), computes
   `anonToken(canvas_user_id, email)`, upserts the result into the
   `students` table.
2. Two hours later (Inngest backoff, retry, whatever), the transcription
   completes, `pushDiscussionToSuperGrader` runs, `buildHarknessEnvelope-
   ForCanvasIds` at `envelope.ts:48-49` selects
   `students.canvas_user_id, email, anon_token` and writes
   `envelope.anon_token = student.anon_token`.
3. The envelope is shipped to SG. SG joins by `anon_token`.

**The latent hazard:**

`students.anon_token` is computed **once** at upload time. It is
**never re-derived** at envelope-build time. If between (1) and (2) the
salt rotates (e.g., emergency rotation per the CLAUDE.md procedure, or
preview-environment salt drift, or rotation followed by partial backfill
that missed this row), the row stores a stale token. SG joins by stale
token, fails to match any peer-tool's current token for the same
student.

The reverse hazard: an admin runs `scripts/rotate-salt.sh` (suite-level)
and re-anonymizes everything except HH's `students.anon_token`. HH's
column is now permanently out-of-sync.

**What bytes cross which boundary:**

The bytes themselves are fine — `Student_<6 hex>` is still a token. But
it's a token that joins **nothing** anymore, because every other
satellite recomputed with the new salt. From SG's perspective, HH stopped
reporting on every student.

Note: this isn't a *PII leak* per se. But it's a privacy-architecture
hazard because the integration-contract §2 promises identical tokens
across the suite — and HH's persistence model makes that promise
fragile.

**Fix direction:**

- Option A (correct + simple): drop `students.anon_token` as a stored
  column. Re-derive at every read site from `canvas_user_id + email`.
  This is exactly what SG, AID, OE, HAH do at envelope-build time. The
  store-once-derive-once-use-many model is a category mistake.
- Option B (preserve cache): keep the column but recompute on read,
  comparing stored vs derived. If they differ, log loudly + update.
  Acts as a self-healing salt-rotation detector.
- Option C (do nothing): formally document that salt rotation requires
  a backfill of `students.anon_token`. Add to `scripts/rotate-salt.sh`.

Today's `scripts/rotate-salt.sh` exists at the suite level — verify it
backfills HH's column. (Out of audit scope; flagging for review.)

---

## Finding 7 — HIGH: Failure-mode storage may leak DB error fragments

**Severity:** High (error-channel PII leak).

**Files / lines:**
- `apps/web/src/lib/peers/notify.ts:94-114` (load-step catch)
- `apps/web/src/lib/peers/notify.ts:157-163` (per-attempt catch)

**The shape:**

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  ...
  super_grader_response: {
    posted_for: [],
    failed: [{ canvas_user_id: "(load)", error: message }],
    ...
  }
}
```

The `err.message` is stored in `discussions.super_grader_response`
(JSONB column) as part of the failed-attempts list. Later visible via
direct DB inspection (and potentially via an admin diagnostic UI, M6.x).

**What can land in `err.message`:**

- Supabase `discussionErr?.message` — typically "row not found", but
  Postgres error messages can include literal column values, including
  email addresses.
- `participationsErr.message` — same.
- Network errors from `fetch(ingestUrl)` — usually URL-only, but in
  edge cases the error message includes response body fragments.
- AbortController timeout — clean message.

**What bytes cross which boundary:**

In the happy case, `err.message` is a stock string ("row not found",
"timeout"). In the unhappy case (rare but plausible), a Postgres error
message includes a value from the failing query, which could include a
participant's email (joined via `students!inner`).

A second concern: `super_grader_response.failed[].error` is stored in
the DB and **could be rendered to the teacher's screen** by future
M6.x diagnostic UI. If that UI ever displays it without scrubbing,
PII appears in plain UI text.

**Fix direction:**

- Pass `err.message` through `scrubText(message, ctx.roster)` before
  storing. Need to thread the roster through to `pushDiscussionToSuper-
  Grader` — fine, the function already loads it.
- Or: strip the `err.message` entirely and store only a category
  (`"load-error"`, `"timeout"`, `"sg-non-2xx"`) plus the HTTP status if
  any. The textual message goes only to Inngest logs (which are
  ephemeral).
- For the per-attempt body slice at line 150 (`body.slice(0, 500)`),
  also scrub through the roster before persistence — SG's error
  response body might echo back a name fragment from the request.

---

## Finding 8 — HIGH: Roster snapshot loaded at transcribe time, not upload time

**Severity:** High. Root cause #1 from the audit brief.

**Files / lines:**
- `apps/web/src/lib/inngest/transcribe-discussion.ts:120-151`
  (roster fetched inside the function, at execution time)
- `apps/web/src/lib/actions/upload-discussion.ts:66-79`
  (roster also fetched at upload time, but only to derive participants
  + anon_tokens — not snapshotted onto the event)

**The window:**

1. Teacher uploads discussion at t=0. `finalizeDiscussion` writes
   `students` rows with `anon_token` from the t=0 roster snapshot.
2. Inngest event fires. Default backoff: immediate, but retries can
   defer up to ~hours.
3. Transcription runs at t=Δ. Loads roster `course_rosters.students`
   again (`transcribe-discussion.ts:125-130`) — but this is the *current*
   roster, not the t=0 roster.
4. Between t=0 and t=Δ, the roster may have changed via
   `syncCanvasCache`:
   - A student added to the course (new student transferred in). Their
     name in the new transcript will be in the roster — good (scrubbed).
   - A student removed from the course. Their `students` row still
     exists (referenced by participations), but the `course_rosters`
     JSONB doesn't include them anymore. **Their name in the transcript
     passes through un-scrubbed.**
   - A student's display name corrected (e.g., legal name change, typo
     fix). Old name no longer in roster JSONB; new name is. Audio
     transcript may contain the old form Gemini heard. Not matched.

**What bytes cross which boundary:**

- A removed student's name appears in `discussions.transcript`
  unscrubbed.
- Ships to SG via the envelope.

This is a low-probability event in a school context (removed mid-term is
rare). Flagged because the audit brief lists snapshot semantics as root
cause #1.

**Fix direction:**

- Pass the roster snapshot through the Inngest event payload:
  ```ts
  await inngest.send({
    name: "discussion.uploaded",
    data: {
      discussionId,
      rosterSnapshot: students, // the roster used at upload time
    },
  });
  ```
  Then in `transcribe-discussion.ts`, prefer `event.data.rosterSnapshot`
  over the live DB read. Falls back to live read only when missing.
- Or: write the snapshot to a new `discussions.roster_snapshot` JSONB
  column at finalize time. Read from there.
- Either pattern documents the snapshot semantics explicitly.

---

## Finding 9 — MEDIUM: The audio→Gemini privacy boundary is undocumented

**Severity:** Medium (audit-trail / accountability gap).

**Files / lines:**
- `transcribe-discussion.ts:154-210` (audio upload to Gemini Files API)
- `CLAUDE.md` (the local doc — no mention of the privacy boundary)

The audio file itself **cannot be scrubbed before reaching Gemini**.
Voices, spoken names, side conversations — all of it crosses to Google's
servers via the Files API. This is the structural privacy boundary in
HH: the audio bytes leave the EHS premises in raw form. The contract is
"Gemini sees real names spoken aloud, the transcript text comes back,
HH scrubs the text before persisting."

This is a defensible posture given EHS's enterprise agreement with Google
Gemini. **But it is not documented anywhere.** The local CLAUDE.md
describes the recorder, the two-pass pipeline, and the scrubbing — but
never explicitly says "the audio is the primary PII channel, and our
privacy posture relies on EHS↔Google enterprise terms, not on
anonymization."

If anyone (admin auditing, FERPA review, security questionnaire from a
school) asks "what student data leaves EHS to Google?", the honest
answer is "the full audio of a Harkness discussion with student voices,
spoken names, and side conversations." That answer needs to be in
writing in CLAUDE.md (and arguably in a teacher-facing privacy notice).

**Fix direction:**

Add to `CLAUDE.md`:

> ### Privacy boundary: audio bytes
>
> The audio recording of a Harkness discussion is the primary PII
> channel in HH and is **not anonymizable before transcription.**
> Voices, spoken names, and side conversations all cross to Google
> Gemini's Files API in raw form (`transcribe-discussion.ts:171-174`).
>
> HH's privacy posture is:
> 1. The audio bytes themselves rely on EHS's Google Workspace
>    enterprise terms (no training on enterprise content).
> 2. The Gemini-transcript text is roster-scrubbed before persistence
>    (`scrub-transcript` step). The transcription prompt also instructs
>    Gemini to anonymize names directly (`Student_xxxxxx`).
> 3. The audio's signed URL has 1-hour TTL when shipped to super-grader
>    or returned via the GET endpoint.
> 4. No audio bytes ever land in Sentry/logs/Inngest payloads.

This is also the audit response. The posture is correct; the
documentation is missing.

---

## Finding 10 — MEDIUM: Admin-editable prompts have no PII-safeguard rails

**Severity:** Medium.

**Files / lines:**
- `apps/web/src/lib/actions/system-prompts.ts:13-51` (no content check)
- `supabase/migrations/20260513120001_admins_and_prompts.sql:135-161` (transcription seed body)
- `supabase/migrations/20260516170000_v1_prompts.sql:28-60` (summary seed body)

The transcription prompt (`purpose='transcription'`) is the **only**
prompt-level barrier against Gemini transcribing real names. Its
"Anonymization" section (`admins_and_prompts.sql:148-153`) instructs
Gemini:

> If any student's name is spoken in the audio, replace it in your
> output with the literal token `Student_xxxxxx`.

This is admin-editable via `/admin/prompts`. `saveSystemPrompt` at
`system-prompts.ts:13-51` has only two validations:
- Body is non-empty.
- Label is non-empty.

There is no:
- Check that the "Anonymization" section survives the edit.
- Check that the summary prompt's "Credit students by name" language
  is consistent with the transcription prompt's anonymization stance.
- Diff confirmation ("you are removing the anonymization clause —
  proceed?").
- Tests pinning the seeded content as a known-good baseline.

An admin who edits the transcription prompt to improve transcript
quality (e.g., adding a "use natural punctuation" clause) might
accidentally drop the anonymization section. Once dropped, every future
transcription writes real names to `discussions.transcript`. Pass-1
scrubber catches some (with Finding 3 caveats); pass-2 amplifies.

**Fix direction:**

- In `saveSystemPrompt`, for `purpose='transcription'`: require the body
  contain a substring like `Student_xxxxxx` or `anonymiz`. Reject saves
  that don't.
- For `purpose='summary'`: warn (or reject) saves that contain
  `by name` (the v1 GROUP_FEEDBACK language is what introduced Finding
  4 — defaulting future edits away from it is good).
- Pin the seeded body in a build-time test: assert the migration's
  seeded transcription body contains the "Anonymization" header.

---

## Finding 11 — MEDIUM: Roster JSONB schema is implicit

**Severity:** Medium.

**Files / lines:**
- `transcribe-discussion.ts:132-143`
- `course_rosters.students` is `jsonb` with no DB-side `check` constraint
  on shape (verified via the migration files).

`transcribe-discussion.ts:132-143` filters incoming rows to those with
`typeof s.email === "string"` and `s.email.length > 0`. Good. But:
- Does not validate `s.name` is a string. A malformed row with
  `name: null` or `name: 12345` would pass — `s.name.length` in
  `scrubText` (`index.ts:55`) would throw at sort-time (`b.name.length`),
  killing the whole scrub.
- An empty string `name: ""` survives the filter (because the filter only
  checks email). At `scrubText:57` the `if (!s.name.trim()) continue`
  skips it — safe. But the regex compilation on whitespace-only names
  would have built `\b\b` patterns matching the empty string between
  every character, replacing all of them with the token. The
  `s.name.trim()` check is critical and is correctly there.

The combination is fragile: future refactors that drop the
`if (!s.name.trim()) continue` line (line 57 of the anonymizer) would
silently replace every char-boundary in the transcript with a token.

**Fix direction:**

- Add stricter validation in `transcribe-discussion.ts`: require both
  `email` and `name` to be non-empty strings.
- Or: add a DB-side jsonschema check constraint on
  `course_rosters.students`.
- Add a test asserting `scrubText(text, [{name: "", email: "x"}])`
  returns `text` unchanged.

---

## Finding 12 — MEDIUM: discussions.audio_url links a Canvas user to spoken voice

**Severity:** Medium (privacy-architecture flag, not a leak today).

**Files / lines:**
- `supabase/migrations/20260513120000_initial_schema.sql:79`
  (`audio_url text not null` — stores storage path verbatim)
- `participations` table links `discussion_id` ↔ `student_id`

The `discussions.audio_url` column holds the storage path
(e.g., `<teacher_id>/<assignment_id>/<filename>.mp4`). The path itself
isn't PII. But joined with `participations.student_id` →
`students.canvas_user_id` + `students.email`, the linkage is:

> "This storage object contains the spoken voice of student
> `Sarah Smith <sarah@episcopalhighschool.org>`."

This is technically correct privacy posture — the bucket is private,
admin-client-only signed URLs, 1-hour TTL — but it means a service-role
key compromise (or a `createAdminDbClient` misuse) hands an attacker the
ability to reconstruct the linkage and replay the audio bytes (= the
single most sensitive PII in the suite).

**What bytes cross which boundary:**

Nothing leaks today. Bucket is private, signed URLs have 1h TTL, no
service-role key has been compromised. The audit flag is about *the
shape of the storage*: HH stores enough metadata to identify the speaker
of any recording.

**Fix direction:**

- Out of scope for short-term: the linkage is needed for the
  envelope-build flow. Can't remove it.
- Long-term: consider per-student storage isolation if the suite ever
  takes a real security review. Today's posture is fine for a single-
  teacher single-school deployment.

---

## Finding 13 — LOW: Anonymizer scrubber drift vs SG (detail)

**Severity:** Low (covered by Finding 3, captured separately for the M5
consolidation rubric).

**Files / lines:**
- `packages/anonymizer/src/index.ts:50-64` (HH)
- `super-grader-v2-SGS/packages/anonymizer/src/scrub.ts:1-190` (SG)

Side-by-side differences:

| Aspect                   | HH                                                | SG                                                              |
|--------------------------|---------------------------------------------------|-----------------------------------------------------------------|
| Name variants            | Full name only                                    | full, first-only, last-only, hyphen-pieces (`nameVariants()`)  |
| Possessive matching      | No                                                | `(?:['\\u2019]s)?` straight + curly apostrophe                  |
| Word boundary            | ASCII `\b` (no `u` flag)                          | Unicode `(?<![\\p{L}\\p{N}_])` lookbehind + lookahead with `u`   |
| Whitespace in name       | Literal space                                     | `\\s+` (handles "Mary  Jane" or `\t`-separated)                  |
| Variant minimum length   | None — would compile `\b\b` for empty name        | `.filter((v) => v.length >= 2)` — skip 1-char names              |
| Structured-fields scrub  | None                                              | `scrubStructured()` with `PII_KEYS` set                          |
| Recursive object scrub   | None                                              | `scrubPayload()` for nested JSON                                 |
| Salt-length floor        | None                                              | `>=16` bytes enforced                                            |
| Salt-empty handling      | Throws (correct)                                  | Throws (correct)                                                 |
| Test coverage            | Zero tests                                        | 30 tests under `packages/anonymizer/`                             |

The token-computation half (`anonToken`) is byte-equivalent (Finding 5).
The scrub half is materially diverged.

**Fix direction:** M5 consolidation. Until then, lift `scrub.ts` from
SG into HH and rebuild HH's `scrubText` on top of `compileRoster` +
`scrubFreeText`. ~80 lines of code copy.

---

## Finding 14 — LOW: Zero tests, anywhere

**Severity:** Low.

**Files / lines:**
- `find packages/anonymizer -name "*.test.ts"` → no matches.
- `find . -name "*.test.ts"` in HH → no matches.

The audit brief specifically asks whether tests would catch the
fail-open shape. There are no tests. (SG has 30 in the same package.)

After Findings 1, 2, 3 are fixed, the minimum test set:
- `scrubText` throws on empty roster (refusing to silently no-op).
- `anonToken` throws on missing salt.
- `anonToken` throws on salt < 16 bytes.
- `anonToken` byte-equivalence vs SG reference for known fixtures
  (this is what `scripts/verify-anonymizer-drift.sh` should hammer
  end-to-end).
- `scrubText` against a fixture with apostrophes, hyphens, possessives,
  first-only utterances, last-only utterances, Unicode-accented names.
- Round-trip: load `course_rosters.students` → call `scrubText` on a
  realistic transcript → assert all roster names are replaced.

---

## Finding 15 — LOW: Audio signed URL has 1h unauthenticated lifetime

**Severity:** Low (documented behavior, flagged).

**Files / lines:**
- `apps/web/src/lib/peers/envelope.ts:5,77-83`
- `apps/web/src/app/api/super-grader/result/route.ts:30-32`

`AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 60` — 1 hour. SG fetches the URL,
passes it to the teacher's browser for playback; the teacher's audio
element fetches the bytes. The URL is **unauthenticated** for that hour
(anyone with the URL can fetch the audio).

SG is on the EHS privacy-side of the boundary, so the intended posture
is: SG handles the URL like a session-scoped credential. If SG ever
logs the URL (Sentry breadcrumb on an audio-fetch error, console.log,
error reporter), the URL leaks into SG's logging infrastructure.

The 30s `Cache-Control: private, max-age=30` on the
`/api/super-grader/result` route (`result/route.ts:31`) is fine for the
JSON envelope itself, but the audio URL inside the envelope is valid for
1 hour regardless.

**Fix direction:**

- Lower TTL to ~5 min (matches `save-to-drive.ts:118` which uses
  `60 * 5` for download). Long enough for SG to render + the teacher
  to start playback; short enough that a leaked URL fades fast.
- Or: tunnel the audio through a SG-authenticated proxy endpoint so the
  bytes never need a public URL.

Defer until SG actually exercises this flow in production (per
`CLAUDE.md`: "HK ↔ SG end-to-end is unexercised in production"). The
first real transcribed discussion will show whether 1h is too generous.

---

## Cross-reference table: every Gemini-bound string + outbound PII surface

| Origin / sink                                  | File:line                                       | Scrubbed? | Notes |
|------------------------------------------------|-------------------------------------------------|-----------|-------|
| Audio bytes → Gemini Files API                 | `transcribe-discussion.ts:171-174`              | N/A       | Unavoidable structural boundary. Finding 9. |
| Transcription system prompt body               | `transcribe-discussion.ts:202`                  | N/A       | Static, no PII. Tells Gemini to anonymize. |
| Verbatim transcript out of Gemini              | `transcribe-discussion.ts:207`                  | **NO if Findings 1/2 trigger**; partial via Gemini's prompt obedience; HH scrubber misses first/last names alone (Finding 3) | Persisted via `save-transcript`. |
| Scrubbed transcript → DB                       | `transcribe-discussion.ts:218-227`              | sometimes | Fail-open per Findings 1+2+3. |
| Scrubbed transcript → Pass 2 input             | `transcribe-discussion.ts:237-240`              | sometimes | Pass 2 amplifies any leak (Finding 4). |
| Summary system prompt body                     | `transcribe-discussion.ts:245`                  | N/A       | Static template; "Credit by name" instruction is itself the bug (Finding 4). |
| Summary text out of Gemini                     | `transcribe-discussion.ts:247`                  | partial   | Same scrubber, same gaps. |
| Scrubbed summary → DB                          | `transcribe-discussion.ts:259-269`              | sometimes | Fail-open per Findings 1+2+3. |
| `discussions.transcript` → envelope            | `envelope.ts:96`                                | inherits  | Whatever was stored is shipped. |
| `discussions.summary` → envelope               | `envelope.ts:97`                                | inherits  | Same. |
| Audio signed URL → envelope                    | `envelope.ts:78-83`                             | N/A (URL) | 1h TTL. Finding 15. |
| Envelope POST to SG                            | `notify.ts:135-143`                             | inherits  | Per-participant fan-out. |
| `/api/super-grader/result` GET                 | `result/route.ts:19-32`                         | inherits  | Same envelope shape, 30s cache. |
| `/api/super-grader/prompt` GET                 | `prompt/route.ts:40-58`                         | N/A       | Returns prompt body; no per-student PII. |
| Save-to-Drive (transcript)                     | `save-to-drive.ts:172`                          | inherits  | Teacher's own Drive — acceptable destination; bytes inherit scrub state. |
| Save-to-Drive (summary)                        | `save-to-drive.ts:195`                          | inherits  | Same. |
| Save-to-Drive (audio)                          | `save-to-drive.ts:148`                          | N/A       | Raw audio to teacher's own Drive. Same posture as Gemini upload. |
| Dashboard render of audio                      | `dashboard/page.tsx:108-115`, `DiscussionList.tsx:209-216` | N/A | 1h signed URL embedded in `<audio>` element. |
| Dashboard render of transcript                 | (not yet shown in UI)                           | N/A       | Stored text is currently teacher-internal. State machine audit will revisit. |
| Sentry / logger                                | none configured (`grep instrumentation*` empty) | N/A       | No Sentry wired up. No `console.log` of transcript bodies. Only `logger.info` line at `transcribe-discussion.ts:86` logs the discussionId + state — no PII. |
| Inngest event payload                          | `upload-discussion.ts:153-156`                  | N/A       | Only `{ discussionId }`. No transcript / no roster shipped through. Good. |

---

## Anonymizer-contract drift summary

**Token computation:** byte-identical to integration-contract §2.

| Field             | Contract (§2)                                       | HH (`anonymizer/src/index.ts:24-33`) | Match? |
|-------------------|-----------------------------------------------------|--------------------------------------|--------|
| algorithm         | HMAC-SHA256                                         | `createHmac("sha256", ...)`         | YES   |
| salt source       | base64-decoded `SUPER_GRADER_SALT`                  | `Buffer.from(salt, "base64")`        | YES   |
| input prefix      | `"ehs\0"`                                           | `Buffer.from("ehs\0")`               | YES   |
| canvas_user_id    | as string                                           | `String(canvasUserId)`               | YES   |
| separator         | `"\0"`                                              | `Buffer.from("\0")`                  | YES   |
| email             | `.trim().toLowerCase()`                             | `email.trim().toLowerCase()`         | YES   |
| token shape       | `"Student_" + first 6 hex chars`                    | `\`Student_${mac.slice(0, 6)}\``     | YES   |

**Operational drift** (NOT in the contract but enforced by SG):

| Safety check                  | SG (`token.ts:23-29`) | HH (`index.ts:18-23`) | Drift? |
|-------------------------------|-----------------------|------------------------|--------|
| Throws on empty salt          | yes                   | yes                    | OK    |
| Enforces salt length ≥ 16 B   | yes                   | **no**                 | DRIFT |

**Scrub-side drift:** see Finding 13 table — material.

---

## Themes (mapped to root causes)

The five root causes from the audit brief map cleanly onto HH's PII
surface:

1. **No snapshot semantics** — Finding 8. Roster is read live at
   transcribe time, not snapshotted at upload time. A student removed
   between upload and Inngest run is leaked.
2. **No state fences on UPDATEs** — out of theme (covered by sibling
   audit).
3. **No transactional boundaries** — Finding 8 (same gap, different lens:
   roster snapshot is not part of the transactional unit that defines
   "this discussion's content").
4. **Fail-open instead of fail-closed** — Findings 1, 2, 3, 11. This is
   the dominant root cause in HH. The roster query, the empty-roster
   path, the regex-shape, and the JSONB validation all chose fail-open
   posture. Combined with Finding 4 (summary prompt actively asks for
   real names), HH has a coherent un-scrubbed-name flow from audio to
   SG ingest.
5. **No retry/idempotency on user-visible mutations** — out of theme.

The single highest-impact bytes-leaking item is the scrub-side gap
(Finding 3 + Finding 4 in combination): first-name utterances in the
audio survive both Gemini prompt-level anonymization (best-effort) and
the regex scrubber (whole-name-only), then the summary pass actively
asks Gemini to credit by name. Both `discussions.transcript` and
`discussions.summary` land with real first names in the DB, get shipped
to SG via the envelope, and persist there indefinitely.

The second-highest is Findings 1+2 (empty-roster fail-open): even with
a fixed scrubber, a missing `course_rosters` row collapses everything
to a no-op and writes verbatim Gemini output. Today, this fires whenever
a teacher transcribes a discussion before running Canvas sync — a
plausible first-use sequence.

Contract drift: anonymizer **token computation** is contract-compliant
byte-for-byte. Anonymizer **scrub** has diverged materially from SG's
implementation (Findings 3, 13). Operational drift: HH skips the salt-
length-floor check that SG enforces (Finding 5).
