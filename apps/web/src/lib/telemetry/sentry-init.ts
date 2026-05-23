import * as Sentry from "@sentry/nextjs";

// M6.22 Phase 0c — Sentry wiring with PII scrubbing.
//
// DSN gates activation: when `SENTRY_DSN` (server) or
// `NEXT_PUBLIC_SENTRY_DSN` (client) is unset, this is a no-op — no init,
// no events, no perf overhead. Today's HH has neither DSN set, so this
// is effectively dead code until an operator provisions a Sentry
// project. Wiring is in place so flipping the DSN on later is one env-var
// change.
//
// `beforeSend` strips PII from error events:
//   - Looks at `exception.values[].value` and `breadcrumbs[].message`.
//   - Allows the literal pattern `Student_xxxxxx` (six lowercase hex).
//   - Redacts any remaining likely-name shape (`\b[A-Z][a-z]+\b`) — this
//     is a heuristic safety net for the case where a Gemini exception
//     message contains a chunk of un-scrubbed transcript text. The cost
//     of a false-positive (a legitimate capitalized word getting masked
//     in a stack trace) is acceptable; the cost of a false-negative
//     (real student name lands in Sentry) is FERPA.
//
// Session Replay is intentionally NOT enabled — HH's dashboard renders
// roster names mid-picker (which is fine — that data stays in the
// teacher's browser), but Session Replay would capture it to Sentry's
// servers. Re-evaluate after Phase 6 normalizes the masking story.

const NAME_LIKE_RE = /\b[A-Z][a-z]+\b/g;
const STUDENT_TOKEN_RE = /^Student_[0-9a-f]{6}$/;

function redactNameLike(input: string): string {
  return input.replace(NAME_LIKE_RE, (match) =>
    STUDENT_TOKEN_RE.test(match) ? match : "[REDACTED-NAME]",
  );
}

export function initSentry(runtime: "node" | "edge" | "browser") {
  const dsn =
    runtime === "browser"
      ? process.env.NEXT_PUBLIC_SENTRY_DSN
      : process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

  if (!dsn) return;

  Sentry.init({
    dsn,
    environment:
      process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    initialScope: { tags: { runtime } },
    beforeSend(event) {
      if (event.exception?.values) {
        for (const exc of event.exception.values) {
          if (typeof exc.value === "string") {
            exc.value = redactNameLike(exc.value);
          }
        }
      }
      if (event.breadcrumbs) {
        for (const crumb of event.breadcrumbs) {
          if (typeof crumb.message === "string") {
            crumb.message = redactNameLike(crumb.message);
          }
        }
      }
      // Strip request URL query strings — a stray `?email=x@y.test` in a
      // GET would leak otherwise.
      if (event.request?.query_string) {
        event.request.query_string = "[REDACTED]";
      }
      return event;
    },
  });
}
