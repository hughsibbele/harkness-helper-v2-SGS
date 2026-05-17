// Anonymization tokens. HMAC-SHA256 derived stable identifier matching the
// ecosystem spec in super-grader's planning/integration-contract.md §2.
//
//   salt   = base64-decoded SUPER_GRADER_SALT (32+ random bytes)
//   input  = "ehs\0" + canvas_user_id + "\0" + email_lowercased
//   token  = "Student_" + first 6 hex chars of HMAC-SHA256(salt, input)
//
// Same algorithm, same inputs, same salt → identical token across every
// tool in the ecosystem (super-grader, HAH, AI Documenter, OE v2). Rotating
// the salt invalidates every stored token — treat as a security incident.

import { createHmac } from "node:crypto";

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
  const input = Buffer.concat([
    Buffer.from("ehs\0"),
    Buffer.from(String(canvasUserId)),
    Buffer.from("\0"),
    Buffer.from(email.trim().toLowerCase()),
  ]);
  const mac = createHmac("sha256", Buffer.from(salt, "base64"))
    .update(input)
    .digest("hex");
  return `Student_${mac.slice(0, 6)}`;
}

export type AnonymizableStudent = {
  canvas_user_id: string;
  name: string;
  email: string;
};

/**
 * Replace any roster student's full name in `text` with their anon_token.
 * Case-insensitive whole-word matches. Longest-name-first so a "Mary Beth
 * Johnson" doesn't get half-clobbered by a separate "Mary" pass.
 *
 * Belt-and-suspenders for the transcription LLM, which is also prompted to
 * anonymize — this scrubs any leaks.
 */
export function scrubText(
  text: string,
  roster: AnonymizableStudent[],
): string {
  let out = text;
  const sorted = [...roster].sort((a, b) => b.name.length - a.name.length);
  for (const s of sorted) {
    if (!s.name.trim()) continue;
    const token = anonToken(s.canvas_user_id, s.email);
    const escaped = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    out = out.replace(re, token);
  }
  return out;
}
