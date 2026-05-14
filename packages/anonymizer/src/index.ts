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
