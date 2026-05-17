"use client";

import { useEffect, useRef, useState } from "react";

type RecorderState = "idle" | "recording" | "paused" | "stopped";

export type RecordedAudio = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
};

export function Recorder({
  onAudioReady,
  onReset,
}: {
  onAudioReady?: (audio: RecordedAudio) => void;
  onReset?: () => void;
}) {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const segmentStartRef = useRef<number>(0);
  const accumulatedRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (state === "recording") {
      tickRef.current = setInterval(() => {
        setElapsedMs(
          accumulatedRef.current + (Date.now() - segmentStartRef.current),
        );
      }, 100);
    }
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [state]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void releaseWakeLock();
    };
  }, [audioUrl]);

  // Re-acquire the wake lock when the user returns to the tab mid-recording.
  // The spec auto-releases the lock on visibility change, so we must request again.
  useEffect(() => {
    function onVisibilityChange() {
      if (
        document.visibilityState === "visible" &&
        (state === "recording" || state === "paused")
      ) {
        void acquireWakeLock();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [state]);

  async function acquireWakeLock(): Promise<void> {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch {
      // Wake lock isn't critical — recording works without it; screen may lock
      // during long recordings on a mobile device. Firefox doesn't support it.
    }
  }

  async function releaseWakeLock(): Promise<void> {
    const lock = wakeLockRef.current;
    if (!lock) return;
    wakeLockRef.current = null;
    try {
      await lock.release();
    } catch {
      // ignore
    }
  }

  function pickMimeType(): string {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    for (const c of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
        return c;
      }
    }
    return "";
  }

  async function start() {
    setError(null);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    chunksRef.current = [];
    accumulatedRef.current = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      mimeRef.current = mimeType;

      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const type = mimeRef.current || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        onAudioReady?.({
          blob,
          mimeType: type,
          durationMs: accumulatedRef.current,
        });
      };

      // 1s timeslice — survives a tab crash with most of the audio intact
      recorder.start(1000);
      segmentStartRef.current = Date.now();
      setElapsedMs(0);
      setState("recording");
      void acquireWakeLock();
    } catch (err) {
      setError(micErrorMessage(err));
      setState("idle");
    }
  }

  function pause() {
    if (!recorderRef.current || state !== "recording") return;
    recorderRef.current.pause();
    accumulatedRef.current += Date.now() - segmentStartRef.current;
    setState("paused");
  }

  function resume() {
    if (!recorderRef.current || state !== "paused") return;
    recorderRef.current.resume();
    segmentStartRef.current = Date.now();
    setState("recording");
  }

  function stop() {
    if (!recorderRef.current) return;
    if (state === "recording") {
      accumulatedRef.current += Date.now() - segmentStartRef.current;
    }
    recorderRef.current.stop();
    setState("stopped");
    void releaseWakeLock();
  }

  function reset() {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    accumulatedRef.current = 0;
    setElapsedMs(0);
    setError(null);
    setState("idle");
    onReset?.();
  }

  const timer = formatElapsed(elapsedMs);

  return (
    <div className="rounded-lg border-2 border-stone-300 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex items-center gap-3 sm:gap-6">
        <RecordButton state={state} onStart={start} onStop={stop} />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-3xl tabular-nums text-ink sm:text-4xl">
            {timer}
          </div>
          <div className="mt-1 text-xs uppercase tracking-wide text-cool-gray">
            {stateLabel(state)}
          </div>
        </div>
        {state === "recording" && (
          <button
            type="button"
            onClick={pause}
            className="shrink-0 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-stone-100"
          >
            Pause
          </button>
        )}
        {state === "paused" && (
          <button
            type="button"
            onClick={resume}
            className="shrink-0 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-stone-100"
          >
            Resume
          </button>
        )}
        {state === "stopped" && (
          <button
            type="button"
            onClick={reset}
            className="shrink-0 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-cool-gray hover:bg-stone-100"
          >
            Re-record
          </button>
        )}
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-700">{error}</p>
      )}

      {audioUrl && state === "stopped" && (
        <div className="mt-4">
          <audio src={audioUrl} controls className="w-full" />
        </div>
      )}
    </div>
  );
}

function RecordButton({
  state,
  onStart,
  onStop,
}: {
  state: RecorderState;
  onStart: () => void;
  onStop: () => void;
}) {
  if (state === "idle" || state === "stopped") {
    return (
      <button
        type="button"
        onClick={onStart}
        aria-label="Start recording"
        className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-red-600 text-white shadow-md transition hover:bg-red-700 active:scale-95 sm:h-20 sm:w-20"
      >
        <span className="block h-6 w-6 rounded-full bg-white sm:h-7 sm:w-7" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onStop}
      aria-label="Stop recording"
      className={
        "grid h-16 w-16 shrink-0 place-items-center rounded-full bg-red-600 text-white shadow-md transition hover:bg-red-700 active:scale-95 sm:h-20 sm:w-20" +
        (state === "recording" ? " animate-pulse" : "")
      }
    >
      <span className="block h-5 w-5 rounded-sm bg-white sm:h-6 sm:w-6" />
    </button>
  );
}

function stateLabel(state: RecorderState): string {
  switch (state) {
    case "idle":
      return "Ready";
    case "recording":
      return "● Recording";
    case "paused":
      return "Paused";
    case "stopped":
      return "Recording captured";
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
      return "Microphone access was denied. iOS: Settings → Safari → Microphone. Desktop Chrome: click the lock icon in the address bar and reset the microphone permission.";
    case "NotFoundError":
      return "No microphone found. Plug one in or check your device's audio input.";
    case "NotReadableError":
      return "The microphone is in use by another app. Close anything else recording or on a call (Zoom, Meet, FaceTime) and try again.";
    case "OverconstrainedError":
      return "Microphone constraints couldn't be satisfied. Try a different audio input device.";
    case "SecurityError":
      return "Microphone blocked by browser security. Make sure the page is loaded over https:// (or localhost).";
    default:
      return err instanceof Error
        ? `Microphone unavailable: ${err.message}`
        : "Microphone unavailable.";
  }
}
