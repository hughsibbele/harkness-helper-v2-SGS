import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

// M6.22 Phase 0b — AES-256-GCM helper for encrypting teacher Google OAuth
// tokens at rest.
//
// **Envelope layout:** base64(iv(12) || authtag(16) || ciphertext).
//
// This matches `@oral-examiner/crypto` and `@ai-documenter/crypto` byte-
// for-byte. The pre-2026-05-24 inline shape was `iv || ciphertext || tag`
// which silently diverged from the package shape; harmonized 2026-05-24
// when verified that no encrypted rows existed yet (zero blast radius).
// Future M5 consolidation can extract a single @harkness-helper/crypto
// package or share the OE/AID package directly.
//
// Key source: TEACHER_GTOKEN_ENC_KEY (base64-encoded 32 bytes). Generated
// once with `openssl rand -base64 32` and stored in Vercel env vars +
// apps/web/.env.local. Rotation: separate operation (suite-level M6.17 will
// ship `scripts/rotate-teacher-gtoken-key.sh`).

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export function readKeyFromEnv(): Buffer {
  const raw = process.env.TEACHER_GTOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "TEACHER_GTOKEN_ENC_KEY is not configured — cannot encrypt/decrypt teacher Google tokens. Generate with `openssl rand -base64 32` and add to env.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TEACHER_GTOKEN_ENC_KEY must decode to exactly 32 bytes (got ${key.length}). Re-generate with \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}

/**
 * Encrypt a token. Returns a base64 envelope safe to store in a text
 * column. Throws if the key env var is missing or malformed — callers
 * should NOT swallow this; surfacing it as a 500 is correct because
 * silently falling back to plaintext re-opens the at-rest leak Phase 0b
 * closes.
 */
export function encryptSecret(plaintext: string): string {
  const key = readKeyFromEnv();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // iv || tag || ciphertext — matches @oral-examiner/crypto +
  // @ai-documenter/crypto. NOT iv || ciphertext || tag.
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt an envelope produced by `encryptSecret`. Throws on tampered
 * ciphertext, wrong key, or malformed envelope.
 */
export function decryptSecret(envelopeB64: string): string {
  const key = readKeyFromEnv();
  const envelope = Buffer.from(envelopeB64, "base64");
  if (envelope.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("encrypted secret envelope is too short");
  }
  const iv = envelope.subarray(0, IV_LEN);
  const tag = envelope.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = envelope.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
