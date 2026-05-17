"use client";

import { useState } from "react";
import { Recorder, type RecordedAudio } from "./Recorder";
import {
  TargetPicker,
  type AssignmentOption,
  type CourseOption,
  type TargetSelection,
} from "./TargetPicker";

export function RecordingFlow({
  courses,
  assignments,
}: {
  courses: CourseOption[];
  assignments: AssignmentOption[];
}) {
  const [audio, setAudio] = useState<RecordedAudio | null>(null);
  const [target, setTarget] = useState<TargetSelection>({
    course: null,
    assignment: null,
  });

  const canUpload = audio !== null && target.assignment !== null;

  return (
    <div className="space-y-6">
      <Recorder onAudioReady={setAudio} onReset={() => setAudio(null)} />

      <section className="rounded-md border border-stone-200 bg-white p-5">
        <TargetPicker
          courses={courses}
          assignments={assignments}
          onChange={setTarget}
        />
      </section>

      <section className="rounded-md border border-stone-200 bg-white p-5">
        <h2 className="ehs-eyebrow mb-3 text-cool-gray">Upload</h2>
        <button
          type="button"
          disabled={!canUpload}
          className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-stone-100 disabled:opacity-50"
          title={
            !audio
              ? "Record audio first"
              : !target.assignment
                ? "Pick a course and assignment first"
                : "Upload coming in the next change"
          }
        >
          Upload recording
        </button>
        <p className="mt-2 text-xs text-cool-gray">
          {audio ? `Recording captured (${formatBytes(audio.blob.size)}, ${formatDuration(audio.durationMs)}).` : "Recording: none yet."}{" "}
          {target.assignment
            ? `Target: ${target.assignment.name}.`
            : "Target: not picked."}
        </p>
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
