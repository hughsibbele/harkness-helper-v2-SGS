// Transcribe a Harkness discussion via Gemini 2.5 Flash audio.
//
// Triggered by `discussion.uploaded` (emitted from the upload server action
// after a successful discussions insert). Durable steps so a mid-flow failure
// re-runs only the failed step on retry. onFailure handler marks the
// discussion row as failed after retries are exhausted.

import { scrubText, type AnonymizableStudent } from "@harkness-helper/anonymizer";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getActiveTranscriptionPrompt } from "@harkness-helper/prompts";
import { inngest } from "./client";

const BUCKET = "discussion-audio";
const SIGNED_URL_TTL_SECONDS = 60 * 30; // 30 min: enough to fetch + upload to Gemini
const FILES_API_POLL_INTERVAL_MS = 2000;
const FILES_API_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_MODEL = "gemini-2.5-flash";

// Raw fetch against the Gemini REST API. The @google/genai 2.3.0 SDK has a
// bug where files.upload doesn't propagate the constructor's apiKey to the
// actual HTTP request — returns "API Key not found" even with a valid key
// (verified via direct curl). Going around the SDK keeps us moving and
// matches the curl shape we know works.

type GeminiFile = {
  name: string;
  uri: string;
  mimeType: string;
  state?: string;
};

async function uploadAudioToGemini(
  apiKey: string,
  audio: Blob,
  mimeType: string,
): Promise<GeminiFile> {
  const url = `${GEMINI_BASE_URL}/upload/v1beta/files?key=${encodeURIComponent(apiKey)}&uploadType=media`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: audio,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini files upload (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { file: GeminiFile };
  if (!json.file?.name || !json.file?.uri) {
    throw new Error("Gemini files upload returned no name/uri");
  }
  return json.file;
}

async function pollGeminiFileUntilActive(
  apiKey: string,
  name: string,
): Promise<GeminiFile> {
  const deadline = Date.now() + FILES_API_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${GEMINI_BASE_URL}/v1beta/${name}?key=${encodeURIComponent(apiKey)}`,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Gemini file poll (${res.status}): ${body.slice(0, 300)}`);
    }
    const file = (await res.json()) as GeminiFile;
    if (file.state === "ACTIVE") return file;
    if (file.state === "FAILED") {
      throw new Error("Gemini Files API processing failed");
    }
    await new Promise((r) => setTimeout(r, FILES_API_POLL_INTERVAL_MS));
  }
  throw new Error("Gemini Files API timed out waiting for ACTIVE state");
}

async function geminiGenerateContent(
  apiKey: string,
  fileUri: string,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const url = `${GEMINI_BASE_URL}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri, mimeType } },
            { text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini generateContent (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned an empty transcript");
  return text;
}

type RosterStudent = {
  canvas_user_id: string;
  name: string;
  email: string | null;
};

export const transcribeDiscussion = inngest.createFunction(
  {
    id: "transcribe-discussion",
    retries: 2,
    triggers: [{ event: "discussion.uploaded" }],
    onFailure: async ({ event, error }) => {
      // FailureEvent wraps the original: event.data.event holds it.
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

    const ctx = await step.run("load-prompt-and-roster", async () => {
      const prompt = await getActiveTranscriptionPrompt();
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
        promptId: prompt.id,
        promptBody: prompt.body,
        roster,
      };
    });

    const transcript = await step.run("gemini-transcribe", async () => {
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
      const mimeType = audioBlob.type || "audio/mp4";

      // mimeType must be in Gemini's accepted set
      // (wav/mp3/aiff/aac/ogg/flac/m4a). webm/opus from Chrome will fail here.
      const uploaded = await uploadAudioToGemini(apiKey, audioBlob, mimeType);
      const active = await pollGeminiFileUntilActive(apiKey, uploaded.name);
      return geminiGenerateContent(
        apiKey,
        active.uri,
        active.mimeType ?? mimeType,
        ctx.promptBody,
      );
    });

    const scrubbed = await step.run("scrub-names", async () => {
      return scrubText(transcript, ctx.roster);
    });

    await step.run("save-transcript", async () => {
      const { error } = await admin
        .from("discussions")
        .update({
          transcript: scrubbed,
          transcription_prompt_id: ctx.promptId,
          state: "transcribed",
        })
        .eq("id", discussionId);
      if (error) throw new Error(`save transcript: ${error.message}`);
    });

    return { discussionId, transcriptLength: scrubbed.length };
  },
);
