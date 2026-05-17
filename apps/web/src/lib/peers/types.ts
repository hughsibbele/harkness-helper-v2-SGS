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
