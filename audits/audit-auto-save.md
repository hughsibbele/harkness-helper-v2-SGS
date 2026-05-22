# HH audit — auto-save conformance + recording-UI state races

Date: 2026-05-22
Reviewer: Claude (Opus 4.7) per Hugh's commission (M6.22, theme #4 of six parallel audits)
Scope: the shared auto-save module + admin-prompts editor that consumes it, and the recorder-side state machine (`Recorder.tsx` → `RecordingFlow.tsx` → `prepareDiscussionUpload` / `finalizeDiscussion`). Out of scope: the Inngest transcribe-discussion pipeline (audit #1), super-grader webhook outbound (audit #5), anonymizer / Canvas integration.
Reference pattern: OE pilot at `oral-examiner-v2-SGS/apps/teacher/components/agent-editor/Primitives.tsx`. HH ported via commit `16b9043`.

Lens (suite-wide root causes carried over from the OE / AID / HAH audits):

1. Snapshot — out of scope.
2. **State fences** — `updated_at` / version guards on saves.
3. Transactional boundaries — multi-step writes (`finalizeDiscussion`).
4. **Fail-open** — failed save / failed finalize silently reverts.
5. **Idempotency** — visibilitychange + blur + debounce single-flighted; double-click on Start; orphan-on-finalize-fail.

Findings are listed worst-first within each severity tier. File:line references are absolute.

---

## CRITICAL — Auto-save has no single-flight / in-flight guard; combine that with `useTransition`'s queueing and a fast typist drops keystrokes

**Files:**
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/components/auto-save/useAutoSaveForm.ts` lines 54–96
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/admin/prompts/PromptEditor.tsx` lines 20, 25–51

**Scenario.** `useAutoSaveForm` calls `saveRef.current()` directly from `fire()` (line 65) on three triggers — debounce expiry, focusout, visibilitychange — with no `if (inflight) return` guard. `PromptEditor.save()` wraps the server-action call in `startTransition` (line 33). React's `useTransition` does NOT serialise: every `startTransition(...)` queues another async run, in submission order.

Concrete two-tab/one-tab race the user can hit by accident:

1. Admin types in the `transcription` prompt body → input event at T=0, debounce timer armed for T+800ms.
2. At T=200ms the admin Alt-Tabs to Canvas to compare a rubric → `visibilitychange→hidden` fires → `fire()` runs → `isFormDirty(form) === true` → `saveRef.current()` → `dispatch({kind:"saving"})` → `startTransition(async () => { saveSystemPrompt(...) })`. PATCH A starts.
3. The admin Alt-Tabs back at T=350ms and types a final word, then clicks into the `summary` editor's textarea at T=450ms. The `focusout` on the transcription form fires → `fire()` runs → still dirty (PATCH A hasn't returned; nothing has re-baselined `defaultValue` yet) → `saveRef.current()` → second `startTransition` → PATCH B starts before A completes.
4. The network reorders: PATCH B's UPDATE serialises at Postgres before A. B's body wins momentarily.
5. PATCH A's UPDATE serialises next. A's stale body lands, **B's later edit is silently overwritten**.
6. Step 2's "saving…" pill flips to "Saved" when *whichever PATCH returns last* (B, the older edit) returns, with no error to the user.

This is the HAH HIGH finding ("No single-flight / in-flight guard") repeating verbatim. HH's hook is a byte-for-byte port of HAH's. It's CRITICAL here because HH `/admin/prompts/page.tsx` line 71 mounts **four** PromptEditors in one `<AutoSaveProvider>` (transcription, summary, speaker_identification, individual_feedback) — far more cross-editor focus traffic than HAH (1 prompt today). The probability of a `focusout` from one editor while another editor's debounce timer is mid-flight is enormous on this page.

Tangential sub-issue: the `useTransition` returns its pending boolean as `[, startTransition]` (line 20) — `_` is discarded, so PromptEditor can't even know "am I currently saving." There's no React-level guard either.

**Fix direction.**
1. Add `useRef<boolean>(false)` (`inflightRef`) inside `PromptEditor.save()`. If `inflightRef.current === true`, set a `needsAnother` ref instead of returning entirely (trailing-edge collapse). On `startTransition`'s `await` completion in the success/error branches, check `needsAnother` and fire one more `save()`. Bursts collapse to "one in-flight + one queued," never two concurrent.
2. Alternatively wire the unused `isPending` from `useTransition` into `save()`: `if (isPending) { pendingFlagRef.current = true; return; }` — cheaper than the manual ref, same trailing-edge logic.
3. Either approach must apply to **the hook itself** (`useAutoSaveForm.ts`) so future per-app consumers don't have to re-discover this. The cleanest fix is to wrap `save` in the hook: the hook owns an `inflightRef`, and only calls `saveRef.current()` if `!inflightRef.current`; `save` returns a Promise that resolves on settled; the hook flips `inflightRef` on/off. Today the hook treats `save` as a fire-and-forget sync function (line 65 — `saveRef.current()` with no await), which is the source of the gap.

---

## CRITICAL — No optimistic-concurrency / version fence on `saveSystemPrompt`; two tabs (or two visibility flips) silently overwrite each other

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/lib/actions/system-prompts.ts` lines 32–47

**Scenario.** `saveSystemPrompt` unconditionally `.update(updates).eq("id", promptId).eq("scope", "system")` — no `updated_at` / version-match `eq` clause. The server returns `{ok:true}` with no row data. The client (`PromptEditor.tsx` line 39) synthesises a fresh `updated_at = new Date().toISOString()` purely client-side.

Two browser tabs on `/admin/prompts` both loaded at `updated_at = 2026-05-21T10:00:00Z`:

1. Tab A types into the `summary` body and autosaves at T=10s → `saveSystemPrompt` writes `body="A's version"`. `updated_at` advances on the DB side via the `prompts_set_updated_at` trigger (migration line 85). Tab A's local `updatedAt` state becomes a client-side `Date.now()` ≈ 10:00:10.
2. Tab B (still on `2026-05-21T10:00:00Z` in its UI; still has the OLD body in the textarea's `defaultValue` because there's no realtime subscription) types into the same prompt body and autosaves at T=20s → `saveSystemPrompt` happily UPDATEs the row again. **Tab A's body is silently overwritten.**

The HH `prompts` table has **no `version` column** (migration `20260513120001_admins_and_prompts.sql` line 49–70 — only `created_at` + `updated_at`). The HH CLAUDE.md note "version bumps on save" is incorrect; there's no version to bump. Phase D's super-grader integration even synthesises `version` from `updated_at` epoch seconds for the outbound prompt-pull contract (per CLAUDE.md, lines 51–55).

Comment on `system-prompts.ts` line 10 says "Admin-gated. The scope='system' filter on the WHERE clause is the security boundary" — that's the authZ boundary, not the concurrency one. Last-write-wins is rationalised everywhere as "admin is one person." It breaks when:
- The same admin has two tabs open (a real workflow — diff against the live prompt body in one tab while editing in another).
- The admin pool grows past one (the `admins` table from migration 023 supports it).
- The auto-save's lack of single-flight (previous finding) issues two overlapping PATCHes from the SAME tab, with the same outcome.

Root cause #2 (state fences).

**Fix direction.**
1. Pass `expected_updated_at` from the client (the originally-loaded `prompt.updated_at`, not the locally-bumped one).
2. Server: `.update(updates).eq("id", promptId).eq("scope", "system").eq("updated_at", expected_updated_at).select("updated_at").maybeSingle()`. If `.data === null` (zero rows matched), return `{ok:false, message:"…", code:"stale", currentBody, currentUpdatedAt}`.
3. Return the new `updated_at` from the DB in the success path so the client's `setUpdatedAt(...)` doesn't fabricate a value.
4. Client: on `code === "stale"`, dispatch `{kind:"error", msg:"Another tab edited this prompt — refresh to see the latest"}` and suppress further auto-saves on this editor until the user reloads (or implement a re-baseline-from-server flow). Today the editor would silently retry with the same stale body on the next keystroke, which means the moment one tab "wins" and the loser keeps typing, the loser will eventually overwrite the winner anyway — exactly the bug to prevent.

---

## HIGH — Aggregator pill green-washes errors across the four prompt editors on `/admin/prompts`

**Files:**
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/components/auto-save/context.tsx` lines 22–28
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/admin/prompts/page.tsx` lines 70–88

**Scenario.** `AutoSaveProvider` holds **one** `useState<AutoSaveStatus>` (line 22) shared across all consumers. `useAutoSaveDispatch()` returns the same setter (line 31–39). The pill renders whatever the *last dispatcher* set.

`/admin/prompts/page.tsx` line 71–87 mounts a `PromptEditor` for each of the four seeded purposes (`transcription`, `summary`, `speaker_identification`, `individual_feedback`) — concrete, not hypothetical. The 1-row shielding HAH benefits from doesn't apply here.

Concrete race:
1. Admin types in the `summary` editor at T=0.
2. Admin tabs into the `individual_feedback` editor at T=300ms, types one character.
3. At T=800ms the `summary` debounce fires → PATCH A starts (`saving` pill).
4. At T=1.1s `summary`'s PATCH A returns with **error** (e.g. transient 500 / network blip / the new fence above tripped) → `dispatch({kind:"error", msg:"…"})` → pill turns red.
5. At T=1.1s `individual_feedback` debounce fires → PATCH B starts → `dispatch({kind:"saving"})` → pill goes back to neutral spinner.
6. At T=1.3s `individual_feedback` PATCH B returns 200 → `dispatch({kind:"saved", at: Date.now()})` → pill turns green: "Saved · just now".
7. User sees "Saved · just now" and assumes everything is safe. The `summary` editor's failure is gone from the UI but the textarea still holds the un-saved body. `defaultValue` was NOT re-baselined on the failed save (PromptEditor.tsx lines 38–49 only re-baseline on the `ok` branch), so `isFormDirty()` still returns true — but with no per-field indicator, the user has no way to know which editor's save was the one that failed.
8. On the next keystroke in the `summary` editor → another save fires → if the error was permanent (validation rejection), the user is now spinning silently with no signal anything is wrong.

This is the AID + HAH HIGH finding repeating across four editors — the most-exposed surface of the pattern in the suite.

**Fix direction.**
1. Track per-key status in the provider: `Map<string, AutoSaveStatus>` keyed by `prompt.id`.
2. Aggregator rule: if ANY editor's status is `"error"`, pill shows error (with that editor's `purpose` + msg). Else if ANY is `"saving"`, show "Saving…". Else if any is `"saved"`, show the most-recent "Saved · Xs ago".
3. `useAutoSaveDispatch()` becomes `useAutoSaveDispatch(key: string)`; PromptEditor passes its `prompt.id`.
4. Surface a per-editor red border + inline error msg under the textarea on failed save so the user can find the broken editor even without aggregator detail.

---

## HIGH — `visibilitychange→hidden` save uses fire-and-forget; tab close during PATCH = data loss with no recovery surface

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/components/auto-save/useAutoSaveForm.ts` lines 80–82, 84–93

**Scenario.** The `onVisibility` handler fires `fire()` on `document.visibilityState === "hidden"`. `fire()` calls `saveRef.current()` synchronously (line 65) — but `saveRef.current` is `PromptEditor.save`, which is itself synchronous and dispatches the actual PATCH inside `startTransition(async () => { await saveSystemPrompt(...) })`. The PATCH is a `fetch` call (server action under the hood), which the browser **does not wait for during tab unload**.

Sequence: user types → ⌘W → `visibilitychange→hidden` fires → `save()` runs → `startTransition(async () => { ... })` schedules a microtask → microtask hasn't yielded to the network stack yet → browser begins tearing down the document → `fetch()` is initiated but cancelled mid-flight when the document is destroyed.

There is no `keepalive: true` on the fetch (server actions don't expose this), no `navigator.sendBeacon` fallback, no IndexedDB stash. The unsaved body is lost with no error surface — the pill doesn't get to render the "save failed" state because the renderer is gone.

This is a fail-open (root cause #4) hidden inside the visibilitychange handler. The OE pilot has the same shape — but the OE pilot's editor screens have heavier guardrails (the AutoSaveStatusPill stays mounted with the page; field counts are smaller). HH inherits the same gap.

The reverse symptom — `visibilitychange→visible` flipping back mid-save — is benign: by then the PATCH has either completed (good) or not (the editor's next input event will retry). But the **hidden** flip is data-loss-shaped.

Combined risk: a teacher edits the summary prompt during a 7-period day, ⌘W'd between meetings, half-typed body lost on close. They reopen the next morning and see the OLD body — assume their edit saved (because the "saving" pill they saw briefly before closing) and the next time the discussion pipeline runs, it runs against the old body.

**Fix direction.**
1. The handler that runs on `visibilitychange→hidden` should NOT route through `startTransition`. Build a parallel synchronous-ish path: serialize the form to FormData inline, then `navigator.sendBeacon(actionUrl, fd)` to a small POST endpoint that does the same UPDATE.
2. Alternatively (cheaper, less correct): stash the unsaved body in `sessionStorage` keyed by `prompt.id` immediately on the hidden flip; on next page load, surface a "You have unsaved changes from your last session — apply or discard?" banner.
3. The cleanest fix is "give up on `visibilitychange` being a save trigger and use sendBeacon for the close case" — server-action-via-RSC doesn't compose with sendBeacon, so the route would need to be a hand-rolled POST endpoint (e.g. `/api/admin/prompts/[id]/save` with bearer-of-session). This is the same shape HAH's `/api/admin/prompts/[key]` PATCH route already has — HH could adopt that.
4. Document the data-loss possibility explicitly in `useAutoSaveForm.ts`'s comment block so future readers don't assume `visibilitychange` is enough.

---

## HIGH — Recorder: Start button has no double-click guard; second click acquires a second `getUserMedia` stream AND a second wake-lock that's never released

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/dashboard/Recorder.tsx` lines 116–164, 84–93

**Scenario.** `RecordButton` (lines 258–292) doesn't disable while `start()` is in flight. `start()` is `async` — the first `await` is `navigator.mediaDevices.getUserMedia` (line 126), which on first-time use shows a permission prompt and can sit pending for **multiple seconds** while the user clicks Allow. During that wait, `state` is still `"idle"` (the React update to `"recording"` happens at line 158, AFTER the await chain). React hasn't re-rendered, so `RecordButton` is still showing the start variant — and is fully clickable.

User double-clicks (or, more likely, clicks Start and then re-clicks because nothing has happened yet — common UX on a slow permission prompt):

1. Click 1 at T=0: `start()` runs. `streamRef.current = null`, `chunksRef.current = []`, `accumulatedRef.current = 0` (lines 122–123). Then `await getUserMedia({audio:true})` (line 126) — pending.
2. Click 2 at T=300ms: `start()` runs *again* (the button hasn't been disabled). `setError(null)` (line 117). `chunksRef.current = []` (line 122) — innocuous. `await getUserMedia({audio:true})` (line 126) — pending. **Now we have two pending media requests.**
3. T=2s: user clicks Allow. Both `getUserMedia` Promises resolve, both with different `MediaStream` instances.
4. First resolver: `streamRef.current = stream_A` (line 127), `recorderRef.current = new MediaRecorder(stream_A)` (line 131), `recorder.start(1000)`, `setState("recording")`, `acquireWakeLock()` → `wakeLockRef.current = lock_A`.
5. Second resolver: `streamRef.current = stream_B` (overwrites stream_A — its tracks are now orphaned but still live), `recorderRef.current = recorder_B` (overwrites recorder_A — recorder_A is still running, with `ondataavailable` still firing into `chunksRef.current`), `recorder_B.start(1000)`, `setState("recording")` (no-op), `acquireWakeLock()` → `wakeLockRef.current = lock_B`. **lock_A is no longer in `wakeLockRef` — it will NEVER be released.**

Consequences:
- Two MediaRecorders push their independent chunk emissions into a shared `chunksRef.current`. The resulting blob is a Frankenstein of two interleaved encoded streams — guaranteed to be unplayable (and Gemini Files API will reject or worse, produce garbage transcript).
- One wake-lock is orphaned indefinitely. On mobile devices this keeps the screen on for the entire battery life, with no UI to surface the leak.
- `streamRef.current` only points at one of the two streams. On `stop()` (line 145) we tear down that stream's tracks; the other stream's tracks stay live, holding the mic open indefinitely (red indicator stays on the tab even when the user thinks they've stopped).

Root cause #5 (no idempotency). The Recorder treats Start as idempotent ("just call it twice, who cares") but it's not.

**Fix direction.**
1. Add `startingRef.current = false`. At the top of `start()`: `if (startingRef.current || state !== 'idle') return; startingRef.current = true; try { ... } finally { startingRef.current = false; }`.
2. Better: gate by state explicitly — `if (state !== 'idle' && state !== 'stopped') return;` AND visually disable the button when `state === 'idle' && startingRef.current` (needs a separate React state so the button can re-render disabled).
3. The simplest fix is: set `setState("recording")` *optimistically* at the top of `start()`, before the `await getUserMedia`. If `getUserMedia` rejects, `setState("idle")` in the catch (line 162). React re-renders the button as the stop variant the moment the click fires, eliminating the re-click window. Trade-off: brief "recording" label before the mic permission completes. Worth it.

---

## HIGH — Recorder: `stop()` while still in `getUserMedia`-pending phase has the same race the other direction, and produces a phantom stream

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/dashboard/Recorder.tsx` lines 180–188, 50–55

**Scenario.** `stop()` (line 180) does `if (!recorderRef.current) return;` — so if the user clicks Stop while `getUserMedia` is still pending, the early-return kicks in (recorderRef hasn't been set yet, line 135 is post-await).

But the user can ONLY click Stop if the button is showing the stop variant. The button switches to stop when `state !== 'idle' && state !== 'stopped'` (lines 267–278). State doesn't flip to `"recording"` until line 158, AFTER `getUserMedia` resolves. So this race is much narrower than the Start one — but it exists in one specific path:

If the user is in the `"stopped"` state with `audioUrl` set, then clicks the Re-record button (line 237 → `reset()` → `setState("idle")`). Then immediately clicks Start. Then `getUserMedia` is pending. The Start button is still in the `idle/stopped` variant (state hasn't flipped). User clicks again — see HIGH finding above.

The narrower Stop-during-pending issue: there's a path where `getUserMedia` resolves AFTER the user has clicked something else (e.g. navigated to `/dashboard/setup`). The component unmounts; the cleanup effect (lines 50–55) runs:
- `URL.revokeObjectURL(audioUrl)` — but `audioUrl` is the captured value from the effect's last render, which is still null (we hadn't recorded yet) — fine.
- `streamRef.current?.getTracks().forEach((t) => t.stop())` — but `streamRef.current` is still null (`getUserMedia` hasn't resolved). So no tracks are stopped.
- `void releaseWakeLock()` — but `wakeLockRef.current` is null. No-op.

Then `getUserMedia` resolves *into the unmounted component's closure*. `streamRef.current = stream` (line 127) — the ref still exists (refs survive unmount). `recorderRef.current = recorder; recorder.start(1000)` (lines 131, 155). **The mic is now hot and recording, with no React UI in sight.** No way to stop it from the UI. The page-level audio indicator (in the browser tab) stays on indefinitely.

Eventually GC will clean the closure but the MediaStream tracks hold strong references via the recorder; they don't get GC'd while the recorder is active. The user must close the tab to free the mic.

Root cause #5. The Recorder doesn't check "am I still mounted?" after `await getUserMedia`.

**Fix direction.**
1. Track mount status: `const mountedRef = useRef(true); useEffect(() => () => { mountedRef.current = false; }, [])`. After every `await` in `start()`, check `if (!mountedRef.current) { stream.getTracks().forEach(t => t.stop()); return; }` — release the stream and abort.
2. Alternative: use an `AbortController` per `start()` invocation; the cleanup effect calls `.abort()`. `getUserMedia` is on the way to supporting AbortSignal natively; today you can wrap the await in a Promise.race against the controller's signal and stop tracks on abort.
3. The cleanup effect at line 50–55 should ALSO call `recorderRef.current?.state === 'recording' && recorderRef.current?.stop()` — today it doesn't stop a recorder that started, just kills the stream's tracks. The recorder's `onstop` will then fire `onAudioReady` on an unmounted component, which React will warn about but not crash.

---

## HIGH — Recorder: tab close mid-record discards the in-progress audio with no recovery; the "1s timeslice" comment is misleading

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/dashboard/Recorder.tsx` lines 137–139, 154

**Scenario.** Comment on line 154: *"1s timeslice — survives a tab crash with most of the audio intact"*. This is wishful thinking. The 1-second timeslice means `ondataavailable` fires every second with a chunk of encoded audio. Those chunks land in `chunksRef.current` (line 138) — an in-memory array on the React component. There is **no IndexedDB write, no localStorage stash, no Blob URL persistence**.

Tab crash sequence:
1. T=0..600s: user records a 10-minute Harkness discussion. `chunksRef.current` accumulates 600 chunks in memory.
2. T=601s: browser crashes / tab is force-closed / laptop runs out of battery / user accidentally hits ⌘W.
3. **All 600 chunks are gone.** The recorder's `onstop` never fires (the closure is destroyed before the user clicks Stop). The blob is never produced. The signed upload URL is never requested.
4. User reopens the page → fresh dashboard → no recording, no UI signal there ever was one.

There is no `beforeunload` handler that warns the user (the standard "you have unsaved changes" prompt). The MediaRecorder keeps going right up until the document tears down — and discards everything.

Combined with the operational reality of Harkness (60–90 minute recordings of an entire class discussion), this is the worst data-loss surface in the app. The CLAUDE notes flag this concern explicitly ("partial-recording recovery"); the audit confirms it has no mitigation today.

Root cause #4 (fail-open — the recorder fails open against tab close). The promise of the timeslice (survives crash) is unfulfilled.

**Fix direction.**
1. Add a `beforeunload` handler when `state === 'recording' || state === 'paused'`:
   ```ts
   useEffect(() => {
     if (state !== 'recording' && state !== 'paused') return;
     const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
     window.addEventListener('beforeunload', handler);
     return () => window.removeEventListener('beforeunload', handler);
   }, [state]);
   ```
   This brings up the browser's "Leave site? Changes you made may not be saved." prompt. Doesn't actually save the recording, but at least the user gets a chance to cancel a misclick on ⌘W.
2. Real fix: write each `ondataavailable` chunk to IndexedDB keyed by `recordingId + sequenceNumber`. On page load, check for a `recordings/<id>/` prefix with chunks → surface "We recovered a 7m 12s recording from your last session — finalize or discard?" banner. After a successful upload (signed URL PUT returns 200), delete the IndexedDB chunks.
3. Cheap intermediate fix: every 30 seconds, snapshot `new Blob(chunksRef.current)` into IndexedDB. Same recovery flow but coarser-grained. Avoids the high-frequency IDB write cost.
4. Don't trust the "1s timeslice survives a crash" claim — that's only true if the chunks are persisted. The current code is purely in-memory.

---

## HIGH — `finalizeDiscussion` is not idempotent against retry; a PUT success + finalize failure leaves an orphan blob with no UI recovery

**Files:**
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/dashboard/RecordingFlow.tsx` lines 48–109
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/lib/actions/upload-discussion.ts` lines 80–102
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/lib/actions/prepare-discussion-upload.ts` lines 42–57

**Scenario.** The two-phase upload is: (1) `prepareDiscussionUpload` issues a signed upload URL after a dedup check; (2) client PUTs the blob to Storage; (3) `finalizeDiscussion` writes the metadata row + fires the Inngest event. Steps 2 and 3 are independent — a 3 failure leaves the blob in storage but no DB row.

Failure mode 1 — `finalizeDiscussion` returns `{ok:false}`:
1. User records audio at T=0..600s.
2. Click Upload at T=605s. `prepareDiscussionUpload` succeeds → signed URL.
3. PUT to Storage at T=605..620s. Returns 200.
4. `finalizeDiscussion` runs:
   - Storage `.list` confirms the upload (line 53). Pass.
   - Roster lookup (line 67). Pass.
   - `discussions.insert` (line 82) returns an error — e.g. the dedup check at line 42 raced with another upload (composite unique on `(canvas_assignment_id, canvas_section_id)` from migration `20260516140000_discussion_per_section.sql` line 20–21), or the network blipped. Comment at line 96–98: *"The unique constraint may have raced with another upload; leave the orphan blob in place — retention sweep handles it."*

**Effects.**
- The blob sits at `<teacherId>/<canvasAssignmentId>/<sectionSlug>/recording.<ext>` indefinitely. There is no retention sweep code in the repo — the comment is aspirational.
- The user sees `setUploadResult({ok:false, message:"discussion insert: …"})` (line 100) — a generic error toast at the bottom of RecordingFlow (line 170–172).
- The Recorder component still holds the audio blob in `chunksRef` + `audioUrl` (the Recorder isn't reset because `r.ok` was false — line 104). The user can click Upload again, but `prepareDiscussionUpload` will REJECT (it sees the dedup conflict, returns "A recording is already linked to this assignment + section" — line 51) **because someone else's row landed.**
- The user is stuck. The only escape is delete-the-conflicting-discussion-via-DiscussionList. Except the conflicting discussion might be... theirs from a successful retry, or another teacher's mid-stream upload, or a stale row from the orphan they're trying to retry. The UX gives them no diagnostic.

Failure mode 2 — `inngest.send` fails (line 153–158):
1. The row is created (state=`uploaded`). The blob is at the storage path. But the Inngest event is dropped — comment line 157: *"Don't block the upload's success on a missing Inngest dev server."* Fine in dev. In production, if Inngest is wedged for any reason (signing-key rotation, registration stale per the CLAUDE.md "PUT /api/inngest after Vercel rename" note), the event is silently lost. The row sits forever at `state='uploaded'`. The dashboard polls (`DiscussionList` line 71–75) every 5s seeing `state==='uploaded'` — the spinner spins forever.

Combined with the audit lens, this is roots #3 (transactional boundaries — no atomic finalize+event) and #5 (no idempotency — the unique-constraint race can't be retried because the dedup check blocks the retry).

**Fix direction.**
1. **Retry-safe finalize.** Change `discussions.insert` to `.upsert({...}, {onConflict: 'canvas_assignment_id,canvas_section_id', ignoreDuplicates: false}).select('id, teacher_id').single()`. If the row already exists AND `teacher_id === currentTeacher.id` AND `audio_url === storagePath`, treat it as success (this is the retry-of-our-own-row case). If it exists with a different `teacher_id` or different `audio_url`, this really is a cross-teacher conflict — reject with a clearer message.
2. **Orphan cleanup on failure.** If `finalizeDiscussion` returns `{ok:false}` due to a non-conflict insert error, the action should `admin.storage.from(BUCKET).remove([storagePath]).catch(() => {})` before returning, so the next retry isn't blocked by a stale dedup check. (The dedup is on the DB row, not the storage object, so the orphan blob doesn't block retry — but it does pile up. The current comment "retention sweep handles it" is incorrect because there's no sweep.)
3. **Inngest re-fire path.** Add an admin "Re-fire transcription" action on any discussion row stuck in `state='uploaded'` for >5 minutes. Or a Vercel Cron job that scans `discussions` for `state='uploaded'` rows older than 5 minutes and re-sends the `discussion.uploaded` event. Per the global memory note, an inngest-resync after Vercel rename + the silent 200 from `inngest.send()` makes the "queue is stuck" case actively dangerous without recovery tooling.
4. **State-machine fence on the row.** When the finalize succeeds, write `state='uploaded'`. If the Inngest send fails, write `state='upload_pending_dispatch'` (new state) — the cron / admin re-fire targets only rows in that state. This is root cause #2 — explicit transitions instead of an implicit assumption.
5. **Surface the error properly.** The "direct upload failed" + "discussion insert" messages in `RecordingFlow.tsx` (lines 81–86, 99–100) are useful for debugging but offer no recovery action to the user. Show "Try again" / "Delete blob and start over" buttons inline.

---

## HIGH — Recorder MIME negotiation falls back to `audio/webm`, which the comment acknowledges Gemini Files API rejects — silent end-of-pipeline failure

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/dashboard/Recorder.tsx` lines 95–114, 140–152

**Scenario.** `pickMimeType()` returns the first supported MIME from `audio/mp4` → `audio/mp4;codecs=mp4a.40.2` → `audio/ogg;codecs=opus` → `audio/webm;codecs=opus` → `audio/webm`. The comment at lines 96–100 says: *"the transcription step will fail on webm with a clear error rather than producing a worse silent issue."*

But the WAY it fails is the silent issue:

1. Firefox user (mainstream browser, no mp4 support, no ogg/opus support — depends on Firefox version; Firefox typically has `audio/ogg;codecs=opus` but NOT `audio/mp4`) records a 90-minute Harkness on `audio/ogg;codecs=opus`. Fine — Gemini Files API accepts ogg.
2. Edge case: an old Firefox or a privacy-hardened browser supports only `audio/webm` (per CLAUDE.md line 162–163, Gemini does NOT accept webm).
3. The user records 90 minutes. PUT succeeds. `finalizeDiscussion` writes the row. State → `uploaded`. Inngest fires.
4. The Inngest function (`transcribe-discussion`) hits Gemini Files API with `audio/webm` → API rejects → onFailure marks `state='failed'`.
5. The user sees a red dot + "Failed" in DiscussionList — 90 minutes later. The audio is in storage. The mic permissions, the wake lock, all of that — wasted.

The fallback to webm is technically failing-closed at the end (Gemini rejects), but the **user-facing** experience is failing-open: the recorder happily produces a blob; the upload happily succeeds; the transcription quietly fails async after 30–60s.

Better posture: **fail-closed at recording start.** If `pickMimeType()` returns `audio/webm` (any flavour), surface a pre-record warning: *"Your browser supports only webm audio, which our transcription pipeline doesn't accept. Please use Chrome or Safari (recommended) for Harkness recording."* — the user is on a desktop in front of a class; tell them BEFORE they record, not after.

Root cause #4 (fail-open). The fallback exists "just in case" but in practice it produces unusable output.

**Fix direction.**
1. Return `null` from `pickMimeType()` when ALL Gemini-compatible formats fail.
2. In `start()`, if `pickMimeType()` returns null, set `error="Your browser doesn't support a transcription-compatible audio format. Try Chrome or Safari."` and return early before requesting the mic.
3. Remove `audio/webm;codecs=opus` and `audio/webm` from the candidate list — keeping them just produces unusable recordings, with no benefit.

---

## MEDIUM — `freshnessKey: prompt.updated_at` wired to a prop that never changes within a session — latent landmine for a future revalidatePath

**Files:**
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/admin/prompts/PromptEditor.tsx` line 53
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/lib/actions/system-prompts.ts` line 49

**Scenario.** `useAutoSaveForm({ formRef, save, freshnessKey: prompt.updated_at })` — the freshnessKey is the prop's `updated_at`, NOT the local `updatedAt` state (line 18). After a successful save, the local `updatedAt` advances but `prompt.updated_at` stays at the initial server-render value forever.

Today the editor doesn't need a freshness-key reset within the session because `defaultValue` is manually re-baselined (lines 44–45). So the only failure mode is the same one HAH flagged: a future PR adds `revalidatePath('/admin/prompts')` to make some sibling save flow fresher, and **the editor's `revalidatePath` call at line 49 of `system-prompts.ts` already exists**.

So this is no longer latent — it's live.

Sequence:
1. User types in the body at T=0.
2. T=800ms: debounce fires → `save()` → PATCH starts.
3. T=1.2s: PATCH returns ok=true. Server action's `revalidatePath('/admin/prompts')` fires (line 49). Next.js queues a re-render.
4. T=1.3s: server re-renders the page. Fresh data: the `prompts` table is re-queried via the admin client (page.tsx line 39). The row's `updated_at` has advanced (DB trigger). Props re-flow into PromptEditor with the new `updated_at`.
5. The `useAutoSaveForm` effect's dependency `freshnessKey` changes → cleanup runs (line 89–95) → any in-flight debounce timer is cleared.
6. But the user has kept typing in the meantime (T=0.5s → "abc", T=1.5s → "abcd"). When the props re-flow at T=1.3s, **the textarea's `defaultValue` is reset to the SERVER-side body** (which is what was just saved: "abc"). The user's "abcd" is preserved (controlled-only-on-mount semantics; React doesn't touch the live `value` of an uncontrolled input after mount even when `defaultValue` changes).
7. But `isFormDirty()` now compares `el.value === "abcd"` against `el.defaultValue === "abc"` — still dirty, save fires again at T=2.1s (debounce reset by the effect cleanup at T=1.3s, restarted on the T=1.5s keystroke). OK, this path actually self-heals.

The bug mode appears differently:
- The hook's effect-cleanup wipes the pending debounce timer when freshnessKey changes (line 94: `if (timer !== null) window.clearTimeout(timer);`).
- If the user types one character and the props re-flow happens BEFORE the 800ms debounce expires, the timer is dropped and the user's keystroke is "forgotten" until they type again (or blur). For a fast-typing user mid-sentence, this is invisible — the next keystroke re-arms. For someone who types one character and waits (e.g. proofreading), the save never fires and they ⌘W with unsaved data — see CRITICAL #4 above.

This is the AID + HAH revalidatePath-cancels-debounce pattern; HH is currently affected because `revalidatePath` IS being called. The HAH audit incorrectly flagged this as "currently dormant" — HH is the same code minus the dormancy.

**Fix direction.**
1. **Drop the `revalidatePath('/admin/prompts')` call** in `saveSystemPrompt` (line 49). The PromptEditor maintains its own local state via the `setUpdatedAt` + manual `defaultValue` re-baseline (lines 39–45). No server revalidation needed.
2. Add a comment on the action explaining the prohibition (mirrors the HAH "MARK AS FORBIDDEN" recommendation from that audit).
3. Long-term, change the hook contract: `freshnessKey` resets only when the row is *externally* updated (e.g. another tab's save lands via a realtime subscription). Within-session saves shouldn't bump it. Today there's no externally-updated signal; the simplest behaviour is "freshnessKey never changes" (= a stable string), and rely on the manual `defaultValue` re-baseline + the optimistic-concurrency fence (CRITICAL #2) for staleness.

---

## MEDIUM — `saveSystemPrompt` doesn't return the new `updated_at`; client fakes it; "Last edited" timestamp lies on multi-second saves

**Files:**
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/lib/actions/system-prompts.ts` lines 30–50
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/admin/prompts/PromptEditor.tsx` lines 39–40

**Scenario.** Server action returns `{ok:true}` with no row data. Client synthesises a fresh `updated_at = new Date().toISOString()` (line 39) and renders "Last edited {formatDate(updatedAt)}" (line 99). The DB-side `updated_at` set by the `prompts_set_updated_at` trigger (migration line 85) is whatever the DB clock said when the UPDATE ran — typically off by 100–800ms from the client's "now", and divergent under clock skew.

Mostly cosmetic, but the displayed value is a lie, and any client that depends on this exact timestamp for optimistic-concurrency (per CRITICAL #2 fix) will diverge from the server. The OE pilot returns the row from its updates and uses the server value.

**Fix direction.**
1. `update(...).select("updated_at").single()` in the server action, return `{ok:true, updated_at}`.
2. Client uses the returned value for both `setUpdatedAt(...)` and for the next `expected_updated_at` in the CRITICAL #2 fence.

---

## MEDIUM — Whitespace-only body trips the client guard but Zod-less server check accepts it on a hypothetical bypass path

**Files:**
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/lib/actions/system-prompts.ts` lines 26–28
- `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/admin/prompts/PromptEditor.tsx` lines 25–30

**Scenario.** Server: `if (!args.body.trim()) return {ok:false, message:"Body can't be empty"}` (line 27). The check is on a trimmed string, falsy when the trimmed string is empty. BUT the saved value is `args.body` (not `args.body.trim()`) — line 28: `updates.body = args.body;`. So a body of `"   actual content   "` saves with leading/trailing whitespace; a body of `"abc\n\n\n\n\n"` saves with five trailing newlines. Probably fine; cosmetic.

The real concern: there's no `min(N)` server-side check for a sensible floor (e.g. a 2-character body would pass), no `max(N)` cap (a 50MB body would either OOM the action or hit Supabase's row-size cap). HAH has the same gap.

**Fix direction.**
1. Trim before save: `updates.body = args.body.trim()` (line 28).
2. Add `if (updates.body.length > 50_000) return {ok:false, message:"Body too long"}` — same shape HAH's PATCH route uses.
3. Add `if (updates.body.length < 50) return {ok:false, message:"Prompt body too short — at least 50 characters expected"}` — protects against an accidental empty-with-one-char save that breaks downstream Gemini calls.

---

## MEDIUM — Recorder's `audioUrl` cleanup leak: `URL.revokeObjectURL` in cleanup effect uses captured closure, not the current value

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/dashboard/Recorder.tsx` lines 50–56

**Scenario.** The cleanup effect at lines 50–56 has `[audioUrl]` as its deps. When `audioUrl` advances (record once, then re-record produces a new URL), the previous effect's cleanup fires with the previous `audioUrl` — which is `null` on the first record. That cleanup runs `URL.revokeObjectURL(null)` — no-op (browsers accept; spec-wise it's allowed). Then the new effect runs with the new `audioUrl`. Fine so far.

The actual leak: `streamRef.current?.getTracks().forEach((t) => t.stop())` runs on EVERY `audioUrl` change, including the initial mount when `audioUrl` is null. At mount, `streamRef.current` is null, so no-op. After the first record completes, `streamRef.current` was set to null inside `recorder.onstop` (line 146), so no-op. After re-record start, `streamRef.current` is set again. Then when `audioUrl` updates (after a stop), the previous cleanup runs `streamRef.current?.getTracks().forEach(...)` against the CURRENT streamRef — but the stream has already been stopped by the recorder's onstop. Double-stop is a no-op.

In practice this isn't leaking, but the dependency declaration is wrong — the cleanup logic shouldn't run on `audioUrl` change at all; it should only run on unmount. The right deps: `[]` for unmount-only, and the function reads refs (which always read latest values).

Minor. Cosmetic. Flagging because the deps-array pattern is repeated in OE / AID and getting it right once for the suite is cheaper than fixing each app.

**Fix direction.**
1. Split the cleanup: a `useEffect(() => () => { void releaseWakeLock(); streamRef.current?.getTracks().forEach(t => t.stop()); }, [])` for unmount, plus a separate `useEffect(() => { return () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }; }, [audioUrl])` for the URL.

---

## LOW — Pill has no "Editing…" / "unsaved" state inside the 800ms debounce window — same UX gap as HAH

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/components/auto-save/AutoSaveStatusPill.tsx` lines 40–61

**Scenario.** Pill renders saving / saved / error. Between typing and the 800ms debounce firing, the pill shows the *previous* state — usually "Saved · 3s ago" even though the DOM holds unsaved characters. Same shape AID + HAH flagged.

Low impact because (a) the window is short, (b) visibilitychange-hidden saves the pending state — BUT see CRITICAL #4 above for why visibilitychange-hidden ISN'T a reliable save path. Combined, the pill is misleading for the ~800ms typing-pause window AND the data can actually be lost in that window on tab close.

**Fix direction.**
1. Add `{kind: "dirty"}` to the union; dispatch from `onInput` BEFORE the debounce expires (or from a separate effect watching `isFormDirty(form)`).
2. Render as neutral "Editing…" pill (no spinner; distinct color from "Saving…").
3. Clear back to saved on save success.

---

## LOW — `Pill` re-mounts on status-kind change (using `seenKind` state) — minor render churn, watch for animation jank

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/components/auto-save/AutoSaveStatusPill.tsx` lines 18–23

**Scenario.** `const [seenKind, setSeenKind] = useState(status.kind); if (seenKind !== status.kind) { setSeenKind(status.kind); if (status.kind === "saved") setLastSavedAt(status.at); }`. Setting state during render is allowed (React documents this pattern) but it triggers an extra render every time the status flips. With four editors on `/admin/prompts` cycling through saving → saved → idle, the pill re-renders 4× per save. With the per-key aggregator fix in HIGH #3, this scales to N editors. Negligible perf-wise, but the spinner animation can hiccup on the boundary.

**Fix direction.**
1. Use a `useEffect(() => { ... }, [status.kind, status])` for the side effect (`setLastSavedAt` on saved). Trade-off: a one-frame delay before the timestamp updates. Acceptable.
2. Or replace the local `seenKind` mirror with reading `status.at` from a ref in the tick effect — eliminates the during-render setState entirely.

---

## LOW — Recorder pause/resume timer accounting may underflow on system clock jump

**File:** `/Users/hkoeze/code/super-grader-suite/harkness-helper-v2-SGS/apps/web/src/app/dashboard/Recorder.tsx` lines 36–48, 166–178, 180–188

**Scenario.** `setElapsedMs(accumulatedRef.current + (Date.now() - segmentStartRef.current))` (line 37). `Date.now()` is wall-clock — affected by NTP corrections, manual clock changes, daylight-saving transitions if the user's TZ rules are weird, sleep/wake on macOS.

Concrete: teacher records during the 2am DST fall-back. `segmentStartRef.current = T_before_DST`. `Date.now()` after 2am is `T_before_DST - 1hr`. `elapsedMs = accumulated + (Date.now() - segmentStartRef)` goes negative → displays a weird timer.

Negligible: nobody records at 2am. But for parity with OE's exam timer (which uses `performance.now()` per the M2b.5d.3 dual-track audio note), HH could use `performance.now()` here — monotonic, no clock-jump issues.

**Fix direction.**
1. Replace `Date.now()` with `performance.now()` in the three places it's used for elapsed-time math (lines 38, 156, 169, 183).
2. Keep `Date.now()` only for human-facing timestamps (none here).

---

## Out-of-scope / clean

- **`useAutoSaveForm` itself is byte-for-byte the OE pilot's hook** (8-character ` ` difference in comment text aside). Same in-flight gap (covered above) but no NEW issues vs OE.
- **`getCurrentAdminEmail` / `isAdmin`** are properly cached + admin-table-backed (`src/lib/auth/admin.ts` lines 13–53). `saveSystemPrompt` calls `getCurrentAdminEmail()` at line 17 → returns null path triggers `{ok:false, message:"Admin only"}` (line 18). Server-side gate is correct.
- **PromptEditor's manual `defaultValue` re-baseline on save success** (lines 44–45) — correctly applied for both `labelRef` and `bodyRef`. Mirrors the OE / AID / HAH pattern.
- **`AutoSaveProvider` correctly wraps the four PromptEditors** (page.tsx line 70–88). The provider exists; the issue is the single-status aggregation (HIGH #3 above), not that it's missing.
- **`AutoSaveStatusPill` "Xs ago" timer** correctly subscribes to a `setInterval` tick (lines 26–38). No render-once-and-leave-stale issue (which AID had briefly).
- **MediaRecorder MIME picking** correctly prefers `audio/mp4` first per the Gemini Files API constraint (Recorder.tsx lines 95–114) — issue is the fallback to webm (HIGH #8), not the priority order.
- **Wake-lock re-acquisition on `visibilitychange→visible`** (Recorder.tsx lines 60–72) correctly fires only when the recorder is active; spec auto-release on background is handled.
- **`finalizeDiscussion` teacher-scope check** (line 40: `if (!storagePath.startsWith(${teacher.id}/))`) correctly defends against a tampered client claiming someone else's upload. Good.
- **Storage `.list` confirmation before INSERT** (`finalizeDiscussion` lines 52–64) correctly verifies the upload landed before creating the row. Defends against the user clicking Upload on an aborted PUT. Good.

---

## Severity ranking (worst-first)

1. **CRITICAL** — No single-flight in auto-save; `startTransition` queues overlapping saves; combined with the missing version fence, fast typists overwrite their own edits across the 4 prompt editors on `/admin/prompts`.
2. **CRITICAL** — No optimistic-concurrency fence on `saveSystemPrompt`; two-tab or one-tab-with-overlapping-saves silently overwrite each other. No `version` column on `prompts` table to fence on.
3. **HIGH** — Aggregator pill green-washes errors across four editors on `/admin/prompts` (single-status `useState` in `AutoSaveProvider`).
4. **HIGH** — `visibilitychange→hidden` save is fire-and-forget; tab close during in-flight PATCH = silent data loss.
5. **HIGH** — Recorder Start button has no double-click / mid-`getUserMedia` guard; two clicks spawn two MediaRecorders sharing a chunk buffer + orphan a wake-lock.
6. **HIGH** — Recorder cleanup doesn't stop `getUserMedia` that resolves after unmount; mic stays hot indefinitely.
7. **HIGH** — Tab close mid-record discards 90 minutes of audio; the "1s timeslice survives a crash" comment is wishful — chunks are in-memory only.
8. **HIGH** — `finalizeDiscussion` non-idempotent against retry; PUT-success-finalize-fail leaves orphan blob the dedup check blocks retry on; Inngest send failure leaves rows pinned at `state='uploaded'` forever.
9. **HIGH** — Recorder fallback to `audio/webm` produces a valid blob the Gemini Files API rejects 60s later — fail-open at recording start.
10. **MEDIUM** — `revalidatePath` in `saveSystemPrompt` interacts with `freshnessKey: prompt.updated_at` to cancel in-flight debounce timers mid-typing.
11. **MEDIUM** — Server action doesn't return the new `updated_at`; client fabricates one; "Last edited" timestamp lies.
12. **MEDIUM** — Whitespace-trim not applied to the saved body; no max-length cap.
13. **MEDIUM** — Recorder cleanup effect's deps array is `[audioUrl]` but cleanup logic touches refs that should be unmount-only.
14. **LOW** — Pill has no "Editing…" state in the 800ms debounce window — misleading UX (compounds with the visibilitychange-hidden data-loss above).
15. **LOW** — Pill's during-render `setSeenKind` triggers an extra render per status flip.
16. **LOW** — Recorder timer uses `Date.now()` instead of `performance.now()`; clock-jump corner case.

---

## Themes

HH's auto-save matches the OE pilot at the source-code level — `useAutoSaveForm.ts` is byte-equivalent. **The drift from the pilot isn't in the hook, it's in the consumer surface:** OE's TemplateEditor mounts one `useTransition` per page with a `status` reducer keyed by `tag`; HH's PromptEditor mounts `useTransition` per editor instance with no aggregation, and the `AutoSaveProvider` collapses four editors into one status slot. The auto-save root causes from the prior audits (HAH HIGH #3 single-status aggregator, HAH HIGH #4 single-flight guard, HAH HIGH #5 optimistic-concurrency fence) all reproduce here — at the same line numbers as HAH (byte-for-byte ports) AND with the multiplicity factor of four editors instead of one, which moves the aggregator finding from "theoretical" to "actively losing errors today."

The recording-UI side has a different shape than the prior audits saw: **the failure modes are physical-world UX races, not DB-state races**. Double-clicks during permission prompts, tabs closed mid-record, mic permission revocation mid-recording — those don't map cleanly onto the snapshot/fence/transaction/fail-open/idempotency framework. They map onto a sixth pattern this audit surfaces: **"the React state machine and the underlying browser-API state machine diverge,"** which is the root behind 5/6/7/8 above. The recorder's `state` enum is a React concept; the MediaRecorder, MediaStream, WakeLockSentinel, and `getUserMedia` Promise are all browser-API concepts with their own lifecycles. The four are stitched together via refs (no React state guard) and the React state lags the browser state by a render. Every HIGH recorder finding is an instance of "click happened in the React state's view of the world, but the browser-API state had progressed past it."

Findings 1, 2, 3, 4 are auto-save root causes #5, #2, #4, #4 respectively. Findings 5–8 are root cause #5 (idempotency) applied to UI state. Finding 9 is root cause #4 (fail-open at recording start). The two highest-impact items are CRITICAL #1 (auto-save data loss across the heaviest-edited admin surface) and HIGH #7 (90-minute Harkness recordings lost on tab close with no recovery) — those should sequence first in any remediation pass.
