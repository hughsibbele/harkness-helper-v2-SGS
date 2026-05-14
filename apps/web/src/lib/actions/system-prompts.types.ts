export type SaveTranscriptionPromptResult =
  | { ok: true }
  | { ok: false; message: string };
