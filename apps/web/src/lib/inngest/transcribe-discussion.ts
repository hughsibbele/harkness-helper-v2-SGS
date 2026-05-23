// Two-pass: verbatim transcript (audio → text) then narrative summary
// (transcript → text). Triggered by `discussion.uploaded`. Durable steps so
// a mid-flow failure re-runs only the failed step on retry.
//
// State flow:
//   uploaded → transcribing → transcribed (terminal happy)
//   any step failure (after retries) → failed (via onFailure handler)
//
// If transcript saves but summary fails, the row keeps the transcript and
// gets state='failed' with an error_message. The Save-to-Drive UI still
// works for the transcript in that case.
//
// M6.22 Phase 0 — Roster scrub is fail-closed. The worker reads the
// `roster_snapshot` JSONB column populated at finalizeDiscussion time,
// falling back to live `course_rosters` ONLY for legacy rows
// (scrub_status='skipped'). If neither yields a non-empty roster, the
// worker refuses to call Gemini and marks the row state='failed' /
// scrub_status='roster_missing'. Closes pii-scrub-audit Findings 1, 2, 8.

import { GoogleGenAI } from "@google/genai";
import {
  compileRoster,
  RosterMissingError,
  scrubFreeText,
  type AnonymizableStudent,
  type CompiledRoster,
} from "@harkness-helper/anonymizer";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import {
  getActiveSummaryPrompt,
  getActiveTranscriptionPrompt,
} from "@harkness-helper/prompts";
import { pushDiscussionToSuperGrader } from "@/lib/peers/notify";
import { inngest } from "./client";

const BUCKET = "discussion-audio";
const SIGNED_URL_TTL_SECONDS = 60 * 30;
const FILES_API_POLL_INTERVAL_MS = 2000;
const FILES_API_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const GEMINI_MODEL = "gemini-2.5-flash";

type SnapshotRosterStudent = {
  canvas_user_id: string;
  name: string;
  email: string | null;
};

// Match v1's getPrompt(): replace every `{key}` occurrence with the value
// (or empty string if the value is null/undefined). v1 used JS regex with
// global flag; we do the same. Keys are alphanumeric/underscore.
function fillTemplate(
  body: string,
  vars: Record<string, string | null | undefined>,
): string {
  let out = body;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${key}\\}`, "g"), value ?? "");
  }
  return out;
}

function normalizeRoster(
  raw: unknown,
): AnonymizableStudent[] {
  if (!Array.isArray(raw)) return [];
  return (raw as SnapshotRosterStudent[])
    .filter(
      (s): s is SnapshotRosterStudent & { email: string } =>
        typeof s?.email === "string" && s.email.trim().length > 0,
    )
    .map((s) => ({
      canvas_user_id: s.canvas_user_id,
      name: s.name,
      email: s.email,
    }));
}

export const transcribeDiscussion = inngest.createFunction(
  {
    id: "transcribe-discussion",
    retries: 2,
    triggers: [{ event: "discussion.uploaded" }],
    onFailure: async ({ event, error }) => {
      const orig = (event.data as { event?: { data?: { discussionId?: string } } })
        .event;
      const discussionId = orig?.data?.discussionId;
      if (!discussionId) return;
      const admin = createAdminDbClient();
      const message = String(error?.message ?? error ?? "unknown");
      const rosterMissing = message.startsWith("RosterMissingError:");
      await admin
        .from("discussions")
        .update({
          state: "failed",
          error_message: message.slice(0, 1000),
          scrub_status: rosterMissing ? "roster_missing" : "failed",
        })
        .eq("id", discussionId);
    },
  },
  async ({ event, step, logger }) => {
    const { discussionId } = event.data as { discussionId: string };
    const admin = createAdminDbClient();

    const discussion = await step.run("load-discussion", async () => {
      const { data, error } = await admin
        .from("discussions")
        .select("*")
        .eq("id", discussionId)
        .single();
      if (error || !data) {
        throw new Error(`load discussion: ${error?.message ?? "not found"}`);
      }
      return data;
    });

    if (discussion.state !== "uploaded") {
      logger.info(
        `skipping ${discussionId} — state is ${discussion.state}, not 'uploaded'`,
      );
      return { skipped: true, state: discussion.state };
    }

    // One rate-limit check up-front. Two Gemini calls per discussion is the
    // implicit cost; teachers adjust their daily cap accordingly.
    await step.run("check-rate-limit", async () => {
      const cap = Number.parseInt(
        process.env.GEMINI_DEFAULT_DAILY_CAP ?? "15",
        10,
      );
      const { data, error } = await admin.rpc(
        "check_and_increment_gemini_call",
        { p_teacher_id: discussion.teacher_id, p_default_cap: cap },
      );
      if (error) throw new Error(`rate-limit RPC: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.allowed) {
        throw new Error(
          `Daily Gemini cap reached: ${row?.calls_today ?? "?"}/${row?.daily_cap ?? "?"}`,
        );
      }
    });

    await step.run("mark-transcribing", async () => {
      const { error } = await admin
        .from("discussions")
        .update({ state: "transcribing", error_message: null })
        .eq("id", discussionId);
      if (error) throw new Error(`mark transcribing: ${error.message}`);
    });

    // Load prompt bodies + roster as durable JSON. The compiled
    // (RegExp-bearing) scrubber is rebuilt OUTSIDE the step from the
    // durable roster array, since RegExp cannot round-trip through
    // step.run's JSON serialization layer.
    //
    // Phase 1 snapshot contract:
    //   - Prompt body comes from discussions.{transcription,summary}_
    //     prompt_body_snapshot when non-null (snapshotted at
    //     finalizeDiscussion time). Closes audit C2 — an admin auto-save
    //     during the job cannot change the body the worker uses, and
    //     Pass 1 + Pass 2 always agree.
    //   - Legacy rows (pre-Phase-1, snapshot columns NULL) fall back to
    //     getActive*Prompt() live read, same as before. Backward-compat.
    //
    // Phase 0 snapshot contract:
    //   - Roster comes from discussions.roster_snapshot (populated at
    //     finalize time). Legacy rows (pre-Phase-0, scrub_status='skipped')
    //     fall back to a live course_rosters read.
    //   - Throws RosterMissingError when no usable roster is available —
    //     onFailure marks scrub_status='roster_missing'.
    const ctx = await step.run("load-prompts-and-roster", async () => {
      // Pin prompt body to the finalize-time snapshot when present.
      let transcriptionPromptId: string | null =
        discussion.transcription_prompt_id;
      let transcriptionPromptBody = discussion.transcription_prompt_body_snapshot;
      let summaryPromptId: string | null = discussion.summary_prompt_id;
      let summaryPromptBody = discussion.summary_prompt_body_snapshot;

      if (!transcriptionPromptBody || !summaryPromptBody) {
        // Legacy row — one or both snapshots are missing. Read live.
        const [tp, sp] = await Promise.all([
          getActiveTranscriptionPrompt(),
          getActiveSummaryPrompt(),
        ]);
        if (!transcriptionPromptBody) {
          transcriptionPromptId = tp.id;
          transcriptionPromptBody = tp.body;
        }
        if (!summaryPromptBody) {
          summaryPromptId = sp.id;
          summaryPromptBody = sp.body;
        }
      }

      let roster = normalizeRoster(discussion.roster_snapshot);

      if (roster.length === 0 && discussion.scrub_status === "skipped") {
        // Legacy row predates the snapshot column — read live as a fallback.
        const { data: rosterRow, error: rosterErr } = await admin
          .from("course_rosters")
          .select("students")
          .eq("teacher_id", discussion.teacher_id)
          .eq("canvas_course_id", discussion.canvas_course_id)
          .maybeSingle();
        if (rosterErr) throw new Error(`roster lookup: ${rosterErr.message}`);
        roster = normalizeRoster(rosterRow?.students);
      }

      if (roster.length === 0) {
        throw new RosterMissingError(
          discussion.roster_snapshot ? "no_email_students" : "missing_row",
          discussion.roster_snapshot
            ? `roster_snapshot has no email-bearing students for discussion ${discussionId}`
            : `no roster_snapshot and no course_rosters row for discussion ${discussionId} ` +
              `(teacher=${discussion.teacher_id}, course=${discussion.canvas_course_id})`,
        );
      }

      return {
        transcriptionPromptId,
        transcriptionPromptBody,
        summaryPromptId,
        summaryPromptBody,
        roster,
      };
    });

    // Compile the scrubber from the durable roster JSON. Cheap, deterministic,
    // and reruns harmlessly on every Inngest replay.
    const compiled: CompiledRoster = compileRoster(ctx.roster);

    // Pass 1: verbatim transcript from audio.
    const rawTranscript = await step.run("gemini-transcribe", async () => {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

      const { data: signed, error: signErr } = await admin.storage
        .from(BUCKET)
        .createSignedUrl(discussion.audio_url, SIGNED_URL_TTL_SECONDS);
      if (signErr || !signed?.signedUrl) {
        throw new Error(`signed URL: ${signErr?.message ?? "none returned"}`);
      }
      const audioRes = await fetch(signed.signedUrl);
      if (!audioRes.ok) {
        throw new Error(`audio download: ${audioRes.status} ${audioRes.statusText}`);
      }
      const audioBlob = await audioRes.blob();

      const ai = new GoogleGenAI({ apiKey });
      const uploaded = await ai.files.upload({
        file: audioBlob,
        config: { mimeType: audioBlob.type || "audio/mp4" },
      });
      if (!uploaded.name) throw new Error("Gemini Files API returned no name");

      let file = uploaded;
      const deadline = Date.now() + FILES_API_POLL_TIMEOUT_MS;
      while (file.state !== "ACTIVE") {
        if (file.state === "FAILED") {
          throw new Error("Gemini Files API processing failed");
        }
        if (Date.now() > deadline) {
          throw new Error("Gemini Files API timed out waiting for ACTIVE state");
        }
        await new Promise((r) => setTimeout(r, FILES_API_POLL_INTERVAL_MS));
        file = await ai.files.get({ name: uploaded.name });
      }

      const result = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  fileUri: file.uri ?? "",
                  mimeType: file.mimeType ?? audioBlob.type,
                },
              },
              { text: ctx.transcriptionPromptBody },
            ],
          },
        ],
      });
      const text = result.text ?? "";
      if (!text.trim()) throw new Error("Gemini returned an empty transcript");
      return text;
    });

    const scrubbedTranscript = await step.run("scrub-transcript", () =>
      scrubFreeText(rawTranscript, compiled),
    );

    // Save transcript before attempting summary — that way a summary failure
    // doesn't lose the transcript work.
    await step.run("save-transcript", async () => {
      const { error } = await admin
        .from("discussions")
        .update({
          transcript: scrubbedTranscript,
          transcription_prompt_id: ctx.transcriptionPromptId,
        })
        .eq("id", discussionId);
      if (error) throw new Error(`save transcript: ${error.message}`);
    });

    // Pass 2: summary (v1's GROUP_FEEDBACK prompt, rewritten in
    // 20260522120001_rewrite_summary_prompt.sql to instruct Gemini to use
    // anonymized tokens — never real names). Receives the already-scrubbed
    // transcript so even if Pass 2 tried to surface a real name, the input
    // doesn't carry one.
    const rawSummary = await step.run("gemini-summarize", async () => {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

      const filled = fillTemplate(ctx.summaryPromptBody, {
        grade: "not yet assigned",
        transcript: scrubbedTranscript,
      });

      const ai = new GoogleGenAI({ apiKey });
      const result = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: filled }] }],
      });
      const text = result.text ?? "";
      if (!text.trim()) throw new Error("Gemini returned an empty summary");
      return text;
    });

    const scrubbedSummary = await step.run("scrub-summary", () =>
      // Defense-in-depth: Pass 2's input was already scrubbed but a model
      // can still hallucinate a name (or partially obey).
      scrubFreeText(rawSummary, compiled),
    );

    await step.run("save-summary", async () => {
      const { error } = await admin
        .from("discussions")
        .update({
          summary: scrubbedSummary,
          summary_prompt_id: ctx.summaryPromptId,
          state: "transcribed",
        })
        .eq("id", discussionId);
      if (error) throw new Error(`save summary: ${error.message}`);
    });

    // Best-effort fan-out to super-grader. pushDiscussionToSuperGrader
    // never throws — failures land in `discussions.super_grader_response`
    // and `super_grader_post_status` for a future retry surface. We do
    // NOT want this step to fail the function, since that would invoke
    // the onFailure handler and clobber state='transcribed'.
    const pushOutcome = await step.run("push-to-super-grader", async () => {
      return pushDiscussionToSuperGrader(discussionId);
    });

    return {
      discussionId,
      transcriptLength: scrubbedTranscript.length,
      summaryLength: scrubbedSummary.length,
      pushOutcome,
    };
  },
);
