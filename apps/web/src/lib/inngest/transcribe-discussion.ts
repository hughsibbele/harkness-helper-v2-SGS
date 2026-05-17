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

import { GoogleGenAI } from "@google/genai";
import { scrubText, type AnonymizableStudent } from "@harkness-helper/anonymizer";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import {
  getActiveSummaryPrompt,
  getActiveTranscriptionPrompt,
} from "@harkness-helper/prompts";
import { inngest } from "./client";

const BUCKET = "discussion-audio";
const SIGNED_URL_TTL_SECONDS = 60 * 30;
const FILES_API_POLL_INTERVAL_MS = 2000;
const FILES_API_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const GEMINI_MODEL = "gemini-2.5-flash";

type RosterStudent = {
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
      await admin
        .from("discussions")
        .update({
          state: "failed",
          error_message: String(error?.message ?? error ?? "unknown").slice(0, 1000),
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

    const ctx = await step.run("load-prompts-and-roster", async () => {
      const [transcriptionPrompt, summaryPrompt] = await Promise.all([
        getActiveTranscriptionPrompt(),
        getActiveSummaryPrompt(),
      ]);
      const { data: rosterRow, error: rosterErr } = await admin
        .from("course_rosters")
        .select("students")
        .eq("teacher_id", discussion.teacher_id)
        .eq("canvas_course_id", discussion.canvas_course_id)
        .maybeSingle();
      if (rosterErr) throw new Error(`roster lookup: ${rosterErr.message}`);
      const rosterStudents: RosterStudent[] = Array.isArray(rosterRow?.students)
        ? (rosterRow.students as RosterStudent[])
        : [];
      const roster: AnonymizableStudent[] = rosterStudents
        .filter((s): s is RosterStudent & { email: string } =>
          typeof s.email === "string" && s.email.length > 0,
        )
        .map((s) => ({
          canvas_user_id: s.canvas_user_id,
          name: s.name,
          email: s.email,
        }));
      return {
        transcriptionPromptId: transcriptionPrompt.id,
        transcriptionPromptBody: transcriptionPrompt.body,
        summaryPromptId: summaryPrompt.id,
        summaryPromptBody: summaryPrompt.body,
        roster,
      };
    });

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

    const scrubbedTranscript = await step.run("scrub-transcript", async () => {
      return scrubText(rawTranscript, ctx.roster);
    });

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

    // Pass 2: summary (v1's GROUP_FEEDBACK prompt). Text-only Gemini call.
    // The prompt body contains {grade} and {transcript} placeholders that v1
    // substitutes server-side; we do the same. {grade} defaults to v1's
    // "not yet assigned" since grading happens later (in super-grader).
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

    const scrubbedSummary = await step.run("scrub-summary", async () => {
      // Defense-in-depth: the transcript was already scrubbed before going
      // into the summary call, but re-run the roster scrub against the output
      // in case the summary phrasing re-introduced any names somehow.
      return scrubText(rawSummary, ctx.roster);
    });

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

    return {
      discussionId,
      transcriptLength: scrubbedTranscript.length,
      summaryLength: scrubbedSummary.length,
    };
  },
);
