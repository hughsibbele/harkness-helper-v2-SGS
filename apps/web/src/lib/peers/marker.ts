/**
 * Sentinel HTML comment that tags a Canvas submission body as authored by
 * Harkness Helper. Super-grader's marker filter (M3.4) reads this to
 * recognize "this submission is a peer-generated transcript, not student
 * work" and route it to the dashboard's Harkness card instead of treating
 * it as essay content. Convention per planning/integration-contract.md
 * §12: `<peer>:<artifact> v=<n>`.
 *
 * Forward-compat only — HK does not currently post transcripts to Canvas
 * submission bodies. Transcripts live in HK; the teacher grades via the
 * dashboard card. This constant exists so that whenever a Canvas-posting
 * flow lands here, the marker is already canonical in one place.
 */
export const HARKNESS_TRANSCRIPT_MARKER = "<!-- harkness:transcript v=1 -->";

/**
 * Prepend the sentinel marker to a Canvas submission body, idempotently —
 * if the body already carries the same marker (typical for re-posts /
 * resends), don't double-stamp.
 */
export function prependHarknessMarker(body: string): string {
  if (body.startsWith(HARKNESS_TRANSCRIPT_MARKER)) return body;
  return `${HARKNESS_TRANSCRIPT_MARKER}\n${body}`;
}
