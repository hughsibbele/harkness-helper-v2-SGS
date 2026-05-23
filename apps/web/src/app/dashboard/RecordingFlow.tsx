"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { prepareDiscussionUpload } from "@/lib/actions/prepare-discussion-upload";
import { finalizeDiscussion } from "@/lib/actions/upload-discussion";
import type { FinalizeDiscussionResult } from "@/lib/actions/upload-discussion.types";
import {
  clearSession,
  listOrphanSessions,
  reconstructSession,
  type PersistedSession,
} from "@/lib/recorder/persistence";
import {
  Recorder,
  type RecordedAudio,
  type RecoveredRecording,
} from "./Recorder";
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

  // M6.22 Phase 3b — crash-recovery state machine.
  // Mount-time: scan IDB for orphan sessions (recordings that started
  // but never reached "successful upload → clearSession"). If any exist,
  // surface the most recent one as a recovery candidate. The teacher
  // either reconstitutes it into the Recorder (Recover) or discards
  // (clears the IDB rows).
  const [orphans, setOrphans] = useState<PersistedSession[]>([]);
  const [recovered, setRecovered] = useState<RecoveredRecording | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await listOrphanSessions();
      if (!cancelled) setOrphans(found);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTargetChange = useCallback(
    (s: TargetSelection) => setTarget(s),
    [],
  );

  async function handleRecover(session_id: string) {
    const reconstructed = await reconstructSession(session_id);
    if (!reconstructed) {
      // The IDB rows vanished between the listOrphans call and now —
      // pretend nothing happened.
      setOrphans((prev) => prev.filter((s) => s.session_id !== session_id));
      return;
    }
    setRecovered({
      blob: reconstructed.blob,
      mimeType: reconstructed.mime_type,
      sessionId: session_id,
    });
    setOrphans((prev) => prev.filter((s) => s.session_id !== session_id));
    setResetCounter((c) => c + 1);
  }

  async function handleDiscardOrphan(session_id: string) {
    await clearSession(session_id);
    setOrphans((prev) => prev.filter((s) => s.session_id !== session_id));
  }

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
        // M6.22 Phase 3b — successful finalize → clear the IDB backup.
        // The bytes are safely in Supabase Storage at this point.
        if (audio.sessionId) {
          await clearSession(audio.sessionId);
        }
        setAudio(null);
        setRecovered(null);
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
      {orphans.length > 0 && !recovered && (
        <RecoveryBanner
          orphans={orphans}
          onRecover={handleRecover}
          onDiscard={handleDiscardOrphan}
        />
      )}

      <Recorder
        key={`recorder-${resetCounter}`}
        onAudioReady={setAudio}
        onReset={() => setAudio(null)}
        recovered={recovered}
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

function RecoveryBanner({
  orphans,
  onRecover,
  onDiscard,
}: {
  orphans: PersistedSession[];
  onRecover: (session_id: string) => void;
  onDiscard: (session_id: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border-2 border-amber-300 bg-amber-50 p-4">
      <h2 className="text-sm font-semibold text-amber-900">
        We found {orphans.length === 1 ? "an" : ""} unfinished recording
        {orphans.length === 1 ? "" : "s"} from a previous session
      </h2>
      <p className="text-xs text-amber-800">
        Tab closed or browser crashed before upload. The audio chunks were
        saved locally — recover to upload them, or discard to clear.
      </p>
      <ul className="space-y-2">
        {orphans.map((o) => (
          <li
            key={o.session_id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-amber-200 bg-white px-3 py-2 text-xs"
          >
            <span className="text-stone-700">
              Started {new Date(o.started_at).toLocaleString()} ·{" "}
              {formatBytes(o.approximate_bytes)} · {o.chunk_count} chunks
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => onRecover(o.session_id)}
                className="rounded-md bg-amber-700 px-3 py-1 font-medium text-white hover:bg-amber-800"
              >
                Recover
              </button>
              <button
                type="button"
                onClick={() => onDiscard(o.session_id)}
                className="rounded-md border border-stone-300 bg-white px-3 py-1 font-medium text-cool-gray hover:bg-stone-100"
              >
                Discard
              </button>
            </span>
          </li>
        ))}
      </ul>
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
