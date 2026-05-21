"use client";

import { useCallback, useState, useTransition } from "react";
import { prepareDiscussionUpload } from "@/lib/actions/prepare-discussion-upload";
import { finalizeDiscussion } from "@/lib/actions/upload-discussion";
import type { FinalizeDiscussionResult } from "@/lib/actions/upload-discussion.types";
import { Recorder, type RecordedAudio } from "./Recorder";
import {
  TargetPicker,
  type AssignmentOption,
  type CourseOption,
  type CourseRoster,
  type TargetSelection,
} from "./TargetPicker";

export function RecordingFlow({
  courses,
  assignments,
  rostersByCourseId,
}: {
  courses: CourseOption[];
  assignments: AssignmentOption[];
  rostersByCourseId: Record<string, CourseRoster>;
}) {
  const [audio, setAudio] = useState<RecordedAudio | null>(null);
  const [target, setTarget] = useState<TargetSelection>({
    course: null,
    assignment: null,
    section: null,
    participantIds: [],
  });
  const [resetCounter, setResetCounter] = useState(0);
  const [uploadResult, setUploadResult] =
    useState<FinalizeDiscussionResult | null>(null);
  const [phase, setPhase] = useState<"idle" | "preparing" | "uploading" | "finalizing">(
    "idle",
  );
  const [pending, startTransition] = useTransition();

  const handleTargetChange = useCallback(
    (s: TargetSelection) => setTarget(s),
    [],
  );

  const canUpload =
    audio !== null && target.course !== null && target.assignment !== null;

  async function run() {
    if (!canUpload || !audio || !target.course || !target.assignment) return;
    setUploadResult(null);

    // 1. Ask the server for a signed upload URL scoped to this teacher +
    //    assignment + section. Server also does the duplicate check so we
    //    fail fast before uploading bytes.
    setPhase("preparing");
    const prep = await prepareDiscussionUpload({
      canvasCourseId: target.course.canvas_course_id,
      canvasAssignmentId: target.assignment.canvas_assignment_id,
      canvasSectionId: target.section?.id ?? null,
      audioMimeType: audio.mimeType,
    });
    if (!prep.ok) {
      setUploadResult({ ok: false, message: prep.message });
      setPhase("idle");
      return;
    }

    // 2. PUT the audio blob directly to Supabase Storage. The signed URL
    //    bypasses Next.js entirely — no server action body-size cap, no
    //    Vercel serverless body cap.
    setPhase("uploading");
    const putRes = await fetch(prep.signedUploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": audio.mimeType || "application/octet-stream",
        "x-upsert": "true",
      },
      body: audio.blob,
    });
    if (!putRes.ok) {
      const body = await putRes.text().catch(() => "");
      setUploadResult({
        ok: false,
        message: `direct upload failed (${putRes.status}): ${body.slice(0, 200)}`,
      });
      setPhase("idle");
      return;
    }

    // 3. Finalize: create the discussion row, hydrate participants, fire
    //    the Inngest event. The action body is now just metadata, well
    //    under any limit.
    setPhase("finalizing");
    startTransition(async () => {
      const r = await finalizeDiscussion({
        storagePath: prep.storagePath,
        canvasCourseId: target.course!.canvas_course_id,
        canvasAssignmentId: target.assignment!.canvas_assignment_id,
        canvasSectionId: target.section?.id ?? null,
        participantIds: target.participantIds,
      });
      setUploadResult(r);
      setPhase("idle");
      if (r.ok) {
        setAudio(null);
        setResetCounter((c) => c + 1);
      }
    });
  }

  const busy = pending || phase !== "idle";
  const phaseLabel =
    phase === "preparing"
      ? "Preparing…"
      : phase === "uploading"
        ? "Uploading…"
        : phase === "finalizing"
          ? "Finalizing…"
          : null;

  return (
    <div className="space-y-6">
      <Recorder
        key={`recorder-${resetCounter}`}
        onAudioReady={setAudio}
        onReset={() => setAudio(null)}
      />

      <section className="rounded-md border border-stone-200 bg-white p-5">
        <TargetPicker
          key={`picker-${resetCounter}`}
          courses={courses}
          assignments={assignments}
          rostersByCourseId={rostersByCourseId}
          onChange={handleTargetChange}
        />
      </section>

      <section className="rounded-md border border-stone-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={!canUpload || busy}
            className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-cool-gray"
            title={
              !audio
                ? "Record audio first"
                : !target.assignment
                  ? "Pick a course and assignment first"
                  : busy
                    ? (phaseLabel ?? "Working…")
                    : "Upload"
            }
          >
            {busy ? (phaseLabel ?? "Working…") : "Upload recording"}
          </button>
          {audio && target.assignment && !busy && !uploadResult && (
            <span className="text-xs text-cool-gray">
              {formatDuration(audio.durationMs)} · {formatBytes(audio.blob.size)}{" "}
              · {target.participantIds.length} participant
              {target.participantIds.length === 1 ? "" : "s"}
            </span>
          )}
          {uploadResult && uploadResult.ok && (
            <span className="text-xs text-emerald-700">
              Uploaded. Transcription is queued.
            </span>
          )}
          {uploadResult && !uploadResult.ok && (
            <span className="text-xs text-red-700">{uploadResult.message}</span>
          )}
        </div>
      </section>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
