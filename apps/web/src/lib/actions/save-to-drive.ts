"use server";

import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import {
  getTeacherGoogleClient,
  GoogleAuthError,
} from "@/lib/google/auth";
import { createDoc } from "@/lib/google/docs";
import { createFolder, uploadAudio, type DriveFileRef } from "@/lib/google/drive";
import type { SaveToDriveResult } from "./save-to-drive.types";

const AUDIO_BUCKET = "discussion-audio";

type DiscussionCtx = {
  id: string;
  teacher_id: string;
  audio_url: string;
  transcript: string | null;
  summary: string | null;
  recorded_at: string;
  state: string;
  canvas_assignment_id: string;
  canvas_course_id: string;
  canvas_section_id: string | null;
  assignmentName: string;
  courseLabel: string;
  sectionName: string | null;
};

async function loadDiscussionCtx(
  discussionId: string,
  teacherId: string,
): Promise<DiscussionCtx | { error: string }> {
  const admin = createAdminDbClient();
  const { data: d, error } = await admin
    .from("discussions")
    .select(
      "id,teacher_id,audio_url,transcript,summary,recorded_at,state,canvas_assignment_id,canvas_course_id,canvas_section_id",
    )
    .eq("id", discussionId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!d) return { error: "Discussion not found." };
  if (d.teacher_id !== teacherId) return { error: "Not authorized." };

  const [{ data: assignment }, { data: course }, { data: roster }] =
    await Promise.all([
      admin
        .from("canvas_assignment_cache")
        .select("name")
        .eq("teacher_id", teacherId)
        .eq("canvas_assignment_id", d.canvas_assignment_id)
        .maybeSingle(),
      admin
        .from("canvas_course_cache")
        .select("name, course_code")
        .eq("teacher_id", teacherId)
        .eq("canvas_course_id", d.canvas_course_id)
        .maybeSingle(),
      admin
        .from("course_rosters")
        .select("sections")
        .eq("teacher_id", teacherId)
        .eq("canvas_course_id", d.canvas_course_id)
        .maybeSingle(),
    ]);

  const sections: Array<{ id: string; name: string }> = Array.isArray(
    roster?.sections,
  )
    ? (roster.sections as Array<{ id: string; name: string }>)
    : [];
  const sectionName = d.canvas_section_id
    ? (sections.find((s) => s.id === d.canvas_section_id)?.name ?? null)
    : null;

  return {
    ...d,
    assignmentName: assignment?.name ?? d.canvas_assignment_id,
    courseLabel: course?.course_code ?? course?.name ?? d.canvas_course_id,
    sectionName,
  };
}

function discussionLabel(ctx: DiscussionCtx): string {
  const parts = [ctx.assignmentName];
  if (ctx.sectionName) parts.push(ctx.sectionName);
  parts.push(formatDate(ctx.recorded_at));
  return parts.join(" · ");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function extensionForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "audio";
}

async function fetchAudio(
  audioStoragePath: string,
): Promise<{ blob: Blob; mimeType: string; ext: string } | { error: string }> {
  const admin = createAdminDbClient();
  const { data: signed, error } = await admin.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(audioStoragePath, 60 * 5);
  if (error || !signed?.signedUrl) {
    return { error: `signed URL: ${error?.message ?? "none"}` };
  }
  const res = await fetch(signed.signedUrl);
  if (!res.ok) return { error: `audio download: ${res.status}` };
  const blob = await res.blob();
  const mimeType = blob.type || "audio/mp4";
  return { blob, mimeType, ext: extensionForMime(mimeType) };
}

function mapErr(err: unknown): string {
  if (err instanceof GoogleAuthError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function saveAudioToDrive(
  discussionId: string,
): Promise<SaveToDriveResult> {
  try {
    const teacher = await getCurrentTeacher();
    const ctx = await loadDiscussionCtx(discussionId, teacher.id);
    if ("error" in ctx) return { ok: false, message: ctx.error };

    const audio = await fetchAudio(ctx.audio_url);
    if ("error" in audio) return { ok: false, message: audio.error };

    const client = await getTeacherGoogleClient(teacher.id);
    const filename = `${discussionLabel(ctx)} · recording.${audio.ext}`;
    const ref = await uploadAudio(
      client,
      { blob: audio.blob, filename, mimeType: audio.mimeType },
      null,
    );
    return { ok: true, links: [{ kind: "audio", webViewLink: ref.webViewLink }] };
  } catch (err) {
    return { ok: false, message: mapErr(err) };
  }
}

export async function saveTranscriptToDrive(
  discussionId: string,
): Promise<SaveToDriveResult> {
  try {
    const teacher = await getCurrentTeacher();
    const ctx = await loadDiscussionCtx(discussionId, teacher.id);
    if ("error" in ctx) return { ok: false, message: ctx.error };
    if (!ctx.transcript) {
      return { ok: false, message: "No transcript yet for this discussion." };
    }

    const client = await getTeacherGoogleClient(teacher.id);
    const title = `${discussionLabel(ctx)} · transcript`;
    const ref = await createDoc(client, title, ctx.transcript, null);
    return {
      ok: true,
      links: [{ kind: "transcript", webViewLink: ref.webViewLink }],
    };
  } catch (err) {
    return { ok: false, message: mapErr(err) };
  }
}

export async function saveSummaryToDrive(
  discussionId: string,
): Promise<SaveToDriveResult> {
  try {
    const teacher = await getCurrentTeacher();
    const ctx = await loadDiscussionCtx(discussionId, teacher.id);
    if ("error" in ctx) return { ok: false, message: ctx.error };
    if (!ctx.summary) {
      return { ok: false, message: "No summary yet for this discussion." };
    }

    const client = await getTeacherGoogleClient(teacher.id);
    const title = `${discussionLabel(ctx)} · summary`;
    const ref = await createDoc(client, title, ctx.summary, null);
    return {
      ok: true,
      links: [{ kind: "summary", webViewLink: ref.webViewLink }],
    };
  } catch (err) {
    return { ok: false, message: mapErr(err) };
  }
}

export async function saveAllToDrive(
  discussionId: string,
): Promise<SaveToDriveResult> {
  try {
    const teacher = await getCurrentTeacher();
    const ctx = await loadDiscussionCtx(discussionId, teacher.id);
    if ("error" in ctx) return { ok: false, message: ctx.error };

    const audio = await fetchAudio(ctx.audio_url);
    if ("error" in audio) return { ok: false, message: audio.error };

    const client = await getTeacherGoogleClient(teacher.id);

    const folderName = discussionLabel(ctx);
    const folder = await createFolder(client, folderName);
    const links: Array<{
      kind: "folder" | "audio" | "transcript" | "summary";
      webViewLink: string;
    }> = [{ kind: "folder", webViewLink: folder.webViewLink }];

    const audioRef: DriveFileRef = await uploadAudio(
      client,
      {
        blob: audio.blob,
        filename: `recording.${audio.ext}`,
        mimeType: audio.mimeType,
      },
      folder.id,
    );
    links.push({ kind: "audio", webViewLink: audioRef.webViewLink });

    if (ctx.transcript) {
      const docRef = await createDoc(client, "transcript", ctx.transcript, folder.id);
      links.push({ kind: "transcript", webViewLink: docRef.webViewLink });
    }

    if (ctx.summary) {
      const docRef = await createDoc(client, "summary", ctx.summary, folder.id);
      links.push({ kind: "summary", webViewLink: docRef.webViewLink });
    }

    return { ok: true, links };
  } catch (err) {
    return { ok: false, message: mapErr(err) };
  }
}
