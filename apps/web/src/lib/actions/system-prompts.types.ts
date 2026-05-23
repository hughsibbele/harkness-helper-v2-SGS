export type SaveSystemPromptResult =
  | { ok: true; updated_at?: string }
  | { ok: false; message: string; conflict?: boolean };
