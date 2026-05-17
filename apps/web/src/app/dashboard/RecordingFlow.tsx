"use client";

import { useCallback, useState, useTransition } from "react";
import { uploadDiscussion } from "@/lib/actions/upload-discussion";
import type { UploadDiscussionResult } from "@/lib/actions/upload-discussion.types";
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
    useState<UploadDiscussionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const handleTargetChange = useCallback(
    (s: TargetSelection) => setTarget(s),
    [],
  );

  const canUpload =
    audio !== null && target.course !== null && target.assignment !== null;

  function run() {
    if (!canUpload || !audio || !target.course || !target.assignment) return;
    setUploadResult(null);

    const ext = extensionForMime(audio.mimeType);
    const file = new File([audio.blob], `recording.${ext}`, {
      type: audio.mimeType,
    });
    const fd = new FormData();
    fd.append("audio", file);
    fd.append("canvas_course_id", target.course.canvas_course_id);
    fd.append("canvas_assignment_id", target.assignment.canvas_assignment_id);
    if (target.section) {
      fd.append("canvas_section_id", target.section.id);
    }
    for (const id of target.participantIds) {
      fd.append("participant_id", id);
    }

    startTransition(async () => {
      const r = await uploadDiscussion(fd);
      setUploadResult(r);
      if (r.ok) {
        setAudio(null);
        setResetCounter((c) => c + 1);
      }
    });
  }

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
            disabled={!canUpload || pending}
            className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-cool-gray"
            title={
              !audio
                ? "Record audio first"
                : !target.assignment
                  ? "Pick a course and assignment first"
                  : pending
                    ? "Uploading…"
                    : "Upload"
            }
          >
            {pending ? "Uploading…" : "Upload recording"}
          </button>
          {audio && target.assignment && !pending && !uploadResult && (
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

function extensionForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "audio";
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
