/**
 * Peer envelope contract — mirrors super-grader's planning/integration-contract.md
 * §4 and packages/peers/src/index.ts (the HarknessSummary shape). Kept
 * identical here so the GET endpoint and the outbound webhook serialize the
 * same JSON super-grader's validator expects.
 */

export type HarknessSummary = {
  audio_url?: string | null;
  transcript?: string | null;
  suggested_summary?: string | null;
  /** M7.9 — Drive webViewLink for the auto-created Google Doc
   *  (M7.5). Doc body = scrubbed summary + scrubbed transcript.
   *  Optional for backwards compatibility with envelopes built
   *  before M7.9 / before the discussion was auto-saved to Drive. */
  google_doc_url?: string | null;
};

export type HarknessEnvelope = {
  schema_version: 1;
  peer: "harkness";
  canvas_user_id: string;
  canvas_assignment_id: string;
  anon_token: string;
  completed_at: string;
  summary: HarknessSummary;
  links: {
    detail_url: string;
  };
};
