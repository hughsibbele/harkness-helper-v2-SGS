"use server";

import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import type { PrepareDiscussionUploadResult } from "./upload-discussion.types";

const BUCKET = "discussion-audio";

function extensionForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "audio";
}

export async function prepareDiscussionUpload(params: {
  canvasCourseId: string;
  canvasAssignmentId: string;
  canvasSectionId: string | null;
  audioMimeType: string;
}): Promise<PrepareDiscussionUploadResult> {
  const teacher = await getCurrentTeacher();

  const canvasCourseId = params.canvasCourseId.trim();
  const canvasAssignmentId = params.canvasAssignmentId.trim();
  const canvasSectionId =
    params.canvasSectionId && params.canvasSectionId.trim().length > 0
      ? params.canvasSectionId.trim()
      : null;

  if (!canvasCourseId) return { ok: false, message: "Course is required." };
  if (!canvasAssignmentId) {
    return { ok: false, message: "Assignment is required." };
  }

  const admin = createAdminDbClient();

  // Dedupe check before issuing an upload URL so the client doesn't waste
  // time PUTting bytes that finalize will reject.
  let duplicateQuery = admin
    .from("discussions")
    .select("id")
    .eq("canvas_assignment_id", canvasAssignmentId);
  duplicateQuery = canvasSectionId
    ? duplicateQuery.eq("canvas_section_id", canvasSectionId)
    : duplicateQuery.is("canvas_section_id", null);
  const { data: existing } = await duplicateQuery.maybeSingle();
  if (existing) {
    return {
      ok: false,
      message: canvasSectionId
        ? "A recording is already linked to this assignment + section. Delete the existing discussion first to re-upload."
        : "A recording without a section is already linked to this assignment. Delete it first to re-upload.",
    };
  }

  const ext = extensionForMime(params.audioMimeType);
  const sectionSlug = canvasSectionId ?? "no-section";
  const storagePath = `${teacher.id}/${canvasAssignmentId}/${sectionSlug}/recording.${ext}`;

  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: true });
  if (error || !data) {
    return {
      ok: false,
      message: `signed url: ${error?.message ?? "unknown error"}`,
    };
  }

  return {
    ok: true,
    storagePath,
    signedUploadUrl: data.signedUrl,
    token: data.token,
  };
}
