// Anonymizer + roster scrubber for Harkness Helper.
//
// Token computation matches the ecosystem spec in super-grader's
// planning/integration-contract.md §2 byte-for-byte:
//   salt   = base64-decoded SUPER_GRADER_SALT (≥16 bytes after decode)
//   input  = "ehs\0" + canvas_user_id + "\0" + email_lowercased
//   token  = "Student_" + first 6 hex chars of HMAC-SHA256(salt, input)
//
// Scrubber matches SG's `packages/anonymizer/src/scrub.ts`: per-roster-entry
// name variants (full / first / last / hyphen-pieces), optional possessive
// (`'s` / `'s`), Unicode-aware word boundaries, longest-first ordering.
// HH's prior scrubber matched only the literal full display_name, which
// missed every first-name utterance — see M6.22 audit-pii-scrub.md F3.
//
// Both `scrubText` and `compileRoster` throw `RosterMissingError` on empty
// roster — refusing to claim a scrub happened when no roster is available.
// Fail-closed posture per M6.22 Phase 0.

import { createHmac } from "node:crypto";

/**
 * Thrown when the roster needed to scrub a transcript or compile a scrubber
 * is missing or empty. Callers catch this and refuse to ship the unscrubbed
 * Gemini output to DB / Drive / super-grader.
 */
export class RosterMissingError extends Error {
  readonly cause_code:
    | "missing_row"
    | "empty_students"
    | "no_email_students"
    | "passed_empty";

  constructor(
    cause_code: RosterMissingError["cause_code"],
    message: string,
  ) {
    super(message);
    this.name = "RosterMissingError";
    this.cause_code = cause_code;
  }
}

export function anonToken(
  canvasUserId: string | number,
  email: string,
): string {
  const salt = process.env.SUPER_GRADER_SALT;
  if (!salt) {
    throw new Error(
      "anonymizer: SUPER_GRADER_SALT is not set. Must match super-grader's salt.",
    );
  }
  const saltBytes = Buffer.from(salt, "base64");
  if (saltBytes.length < 16) {
    throw new Error(
      `anonymizer: salt is suspiciously short (${saltBytes.length} bytes after base64 decode). ` +
        "Generate at least 32 bytes via `openssl rand -base64 32`.",
    );
  }
  const input = Buffer.concat([
    Buffer.from("ehs\0"),
    Buffer.from(String(canvasUserId)),
    Buffer.from("\0"),
    Buffer.from(email.trim().toLowerCase()),
  ]);
  const mac = createHmac("sha256", saltBytes).update(input).digest("hex");
  return `Student_${mac.slice(0, 6)}`;
}

export type AnonymizableStudent = {
  canvas_user_id: string;
  name: string;
  email: string;
};

export type CompiledRoster = {
  variants: ReadonlyArray<{ pattern: RegExp; token: string }>;
};

const NAME_BOUNDARY_PRE = "(?<![\\p{L}\\p{N}_])";
const NAME_BOUNDARY_POST = "(?![\\p{L}\\p{N}_])";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generate the match-variants for one student's display name:
 * full, first-only, last-only, plus each hyphen-piece of a hyphenated
 * last name. Variants under 2 chars are dropped (a single-letter name
 * fragment would produce an absurdly noisy regex).
 */
function nameVariants(displayName: string): string[] {
  const cleaned = displayName.trim();
  if (!cleaned) return [];

  const parts = cleaned.split(/\s+/).filter(Boolean);
  const variants = new Set<string>();

  variants.add(cleaned);
  if (parts[0]) variants.add(parts[0]);

  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (last) {
      variants.add(last);
      if (last.includes("-")) {
        for (const piece of last.split("-").filter(Boolean)) {
          variants.add(piece);
        }
      }
    }
  }

  return [...variants].filter((v) => v.length >= 2);
}

/**
 * Compile a name-redaction regex per roster entry, covering all of its
 * variants. Optional trailing possessive `'s` / `'s` is consumed by the
 * replacement (so "Sarah's" → "Student_aabbcc", not "Student_aabbcc's").
 *
 * Throws `RosterMissingError` on empty roster — fail-closed.
 *
 * Patterns are sorted longest-first so "Mary Jane Smith" beats "Mary".
 */
export function compileRoster(roster: AnonymizableStudent[]): CompiledRoster {
  if (!roster || roster.length === 0) {
    throw new RosterMissingError(
      "passed_empty",
      "compileRoster: empty roster — refusing to claim a scrub happened.",
    );
  }

  const items: Array<{ pattern: RegExp; token: string; len: number }> = [];

  for (const entry of roster) {
    if (!entry.email || !entry.email.trim()) continue;
    const token = anonToken(entry.canvas_user_id, entry.email);
    for (const variant of nameVariants(entry.name)) {
      const escaped = escapeRegex(variant).replace(/\s+/g, "\\s+");
      const body = `${escaped}(?:['\\u2019]s)?`;
      const pattern = new RegExp(
        `${NAME_BOUNDARY_PRE}${body}${NAME_BOUNDARY_POST}`,
        "giu",
      );
      items.push({ pattern, token, len: variant.length });
    }
  }

  if (items.length === 0) {
    throw new RosterMissingError(
      "no_email_students",
      "compileRoster: no roster entries had a usable name + email.",
    );
  }

  items.sort((a, b) => b.len - a.len);
  return {
    variants: items.map(({ pattern, token }) => ({ pattern, token })),
  };
}

/**
 * Apply a compiled roster to free text. Each pattern's `g` flag is reset
 * per pass by the regex engine.
 */
export function scrubFreeText(text: string, compiled: CompiledRoster): string {
  let out = text;
  for (const { pattern, token } of compiled.variants) {
    out = out.replace(pattern, token);
  }
  return out;
}

/**
 * Convenience: compile + scrub in one call. Throws `RosterMissingError`
 * on empty roster (via `compileRoster`).
 *
 * Prefer this when the caller scrubs only one string per request. For
 * batch flows (e.g., scrub both transcript and summary), call
 * `compileRoster` once and reuse the compiled object.
 */
export function scrubText(
  text: string,
  roster: AnonymizableStudent[],
): string {
  const compiled = compileRoster(roster);
  return scrubFreeText(text, compiled);
}
