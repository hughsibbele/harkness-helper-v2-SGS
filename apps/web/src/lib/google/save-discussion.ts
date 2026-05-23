// M7.5 — automatic Drive save for a discussion. Called from the Inngest
// worker after Pass-1 commit + Pass-2 (success or recorded-failure).
//
// Creates one Doc (transcript + summary, both already scrubbed) and one
// audio file in the teacher's per-app folder. Doc + audio share a base
// name so they sort together in Drive.
//
// Idempotent at the caller — the Inngest worker skips this step if the
// discussion row already has a drive_doc_url. Inside this function we
// don't dedup further; a re-run would create a second doc (which is
// what M6.22 Phase 2's state fences exist to prevent).

import { createAdminDbClient } from "@harkness-helper/db/admin";
import type { Auth } from "googleapis";
import { createDoc } from "./docs";
import {
  getOrCreateAppFolder,
  shareWithDomain,
  uploadAudio,
  type DriveFileRef,
} from "./drive";
import { getTeacherGoogleClient } from "./auth";

const AUDIO_BUCKET = "discussion-audio";
const APP_FOLDER_NAME = "Harkness Helper";

export type SavedDiscussionRefs = {
  doc: DriveFileRef;
  audio: DriveFileRef;
  folder: { id: string; created: boolean };
};

export type DiscussionForDriveSave = {
  id: string;
  teacher_id: string;
  audio_url: string;
  transcript: string | null;
  summary: string | null;
  recorded_at: string;
  canvas_assignment_id: string;
  canvas_course_id: string;
  canvas_section_id: string | null;
};

function extensionForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "audio";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function composeBaseName(args: {
  assignmentName: string;
  sectionName: string | null;
  recordedAt: string;
}): string {
  // BUILD_PLAN M7 per-app row for HH: `{section} – {date} – {assignment}`.
  const parts: string[] = [];
  if (args.sectionName) parts.push(args.sectionName);
  parts.push(formatDate(args.recordedAt));
  parts.push(args.assignmentName);
  return parts.join(" – ");
}

function composeDocBody(args: {
  transcript: string | null;
  summary: string | null;
}): string {
  const sections: string[] = [];
  if (args.summary && args.summary.trim().length > 0) {
    sections.push("SUMMARY", "", args.summary.trim());
  }
  if (args.transcript && args.transcript.trim().length > 0) {
    if (sections.length > 0) sections.push("", "", "TRANSCRIPT", "");
    else sections.push("TRANSCRIPT", "");
    sections.push(args.transcript.trim());
  }
  if (sections.length === 0) {
    // Nothing to write — caller should have skipped, but produce
    // *something* so the Doc doesn't end up empty.
    sections.push("(transcription is still in progress)");
  }
  return sections.join("\n");
}

async function loadLabels(args: {
  teacherId: string;
  canvasAssignmentId: string;
  canvasCourseId: string;
  canvasSectionId: string | null;
}): Promise<{
  assignmentName: string;
  sectionName: string | null;
}> {
  const admin = createAdminDbClient();
  const [{ data: assignment }, { data: roster }] = await Promise.all([
    admin
      .from("canvas_assignment_cache")
      .select("name")
      .eq("teacher_id", args.teacherId)
      .eq("canvas_assignment_id", args.canvasAssignmentId)
      .maybeSingle(),
    args.canvasSectionId
      ? admin
          .from("course_rosters")
          .select("sections")
          .eq("teacher_id", args.teacherId)
          .eq("canvas_course_id", args.canvasCourseId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const sections: Array<{ id: string; name: string }> = Array.isArray(
    (roster as { sections?: unknown } | null)?.sections,
  )
    ? ((roster as { sections: Array<{ id: string; name: string }> }).sections)
    : [];
  const sectionName = args.canvasSectionId
    ? (sections.find((s) => s.id === args.canvasSectionId)?.name ?? null)
    : null;

  return {
    assignmentName: assignment?.name ?? args.canvasAssignmentId,
    sectionName,
  };
}

async function fetchAudio(audioStoragePath: string): Promise<{
  blob: Blob;
  mimeType: string;
  ext: string;
}> {
  const admin = createAdminDbClient();
  const { data: signed, error } = await admin.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(audioStoragePath, 60 * 10);
  if (error || !signed?.signedUrl) {
    throw new Error(`signed URL: ${error?.message ?? "none returned"}`);
  }
  const res = await fetch(signed.signedUrl);
  if (!res.ok) throw new Error(`audio download: ${res.status}`);
  const blob = await res.blob();
  const mimeType = blob.type || "audio/mp4";
  return { blob, mimeType, ext: extensionForMime(mimeType) };
}

/**
 * Drive-save the discussion's transcript+summary doc + audio file.
 *
 * Persists the resulting folder id back to `teachers.drive_folder_id` if
 * it was auto-created (so the next save reuses it). Returns the Drive
 * refs for the worker to write onto the discussion row.
 */
export async function saveDiscussionToDrive(
  discussion: DiscussionForDriveSave,
): Promise<SavedDiscussionRefs> {
  const admin = createAdminDbClient();

  const { data: teacher, error: teacherErr } = await admin
    .from("teachers")
    .select("drive_folder_id")
    .eq("id", discussion.teacher_id)
    .single();
  if (teacherErr || !teacher) {
    throw new Error(`teacher lookup: ${teacherErr?.message ?? "not found"}`);
  }

  const client: Auth.OAuth2Client = await getTeacherGoogleClient(
    discussion.teacher_id,
  );

  const folder = await getOrCreateAppFolder(
    client,
    teacher.drive_folder_id,
    APP_FOLDER_NAME,
  );
  if (folder.created) {
    await admin
      .from("teachers")
      .update({ drive_folder_id: folder.id })
      .eq("id", discussion.teacher_id);
  }

  const labels = await loadLabels({
    teacherId: discussion.teacher_id,
    canvasAssignmentId: discussion.canvas_assignment_id,
    canvasCourseId: discussion.canvas_course_id,
    canvasSectionId: discussion.canvas_section_id,
  });
  const baseName = composeBaseName({
    assignmentName: labels.assignmentName,
    sectionName: labels.sectionName,
    recordedAt: discussion.recorded_at,
  });

  const docBody = composeDocBody({
    transcript: discussion.transcript,
    summary: discussion.summary,
  });
  const doc = await createDoc(client, baseName, docBody, folder.id);
  // Share the doc with the EHS domain too — same M7 invariant as the
  // folder. Best-effort.
  await shareWithDomain(client, doc.id).catch(() => {});

  const audio = await fetchAudio(discussion.audio_url);
  const audioRef = await uploadAudio(
    client,
    {
      blob: audio.blob,
      filename: `${baseName}.${audio.ext}`,
      mimeType: audio.mimeType,
    },
    folder.id,
  );

  return {
    folder: { id: folder.id, created: folder.created },
    doc,
    audio: audioRef,
  };
}
