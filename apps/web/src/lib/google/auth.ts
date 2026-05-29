// OAuth2 client per teacher, with automatic token refresh.
//
// Tokens are stored on teachers.google_*_encrypted (AES-256-GCM envelopes,
// M6.22 Phase 0b) — written by the /auth/callback handler. The legacy
// plaintext columns (`google_{access,refresh}_token`) were dropped by
// migration 20260524100000; this helper reads the encrypted columns only.
//
// 1. Loads the row.
// 2. If the access token is within 5 min of expiry (or already past),
//    refreshes via the googleapis SDK using the stored refresh_token.
// 3. Writes the new access_token (encrypted) + expires_at back to the DB.
// 4. Returns an OAuth2 client configured with the current credentials.

import { google, type Auth } from "googleapis";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class GoogleAuthError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/**
 * Decrypt a token from its encrypted column. Returns null if the column is
 * empty. Throws if decryption fails (tampered envelope, wrong key) — callers
 * surface that as a 500 rather than falling back, since there is no plaintext
 * column to fall back to (dropped by migration 20260524100000).
 */
function readEncrypted(encrypted: string | null): string | null {
  if (encrypted) return decryptSecret(encrypted);
  return null;
}

export async function getTeacherGoogleClient(
  teacherId: string,
): Promise<Auth.OAuth2Client> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GoogleAuthError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.",
      "missing_oauth_config",
    );
  }

  const admin = createAdminDbClient();
  const { data: teacher, error } = await admin
    .from("teachers")
    .select(
      "google_access_token_encrypted, google_refresh_token_encrypted, google_token_expires_at",
    )
    .eq("id", teacherId)
    .maybeSingle();
  if (error) throw new GoogleAuthError(`teacher lookup: ${error.message}`);
  if (!teacher) throw new GoogleAuthError("Teacher not found.", "not_found");

  const accessToken = readEncrypted(teacher.google_access_token_encrypted);
  const refreshToken = readEncrypted(teacher.google_refresh_token_encrypted);

  const expiry = teacher.google_token_expires_at
    ? new Date(teacher.google_token_expires_at).getTime()
    : 0;
  const accessValid = !!accessToken && Date.now() + REFRESH_BUFFER_MS < expiry;

  // We can proceed if we have either a usable access_token OR a refresh_token.
  // If we have only an expired access_token and no refresh, the teacher needs
  // to sign in again (Google won't issue a fresh refresh_token without consent).
  if (!accessValid && !refreshToken) {
    throw new GoogleAuthError(
      "Google authorization expired. Sign out and sign in again to re-grant Drive access.",
      "missing_refresh_token",
    );
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({
    access_token: accessToken ?? undefined,
    refresh_token: refreshToken ?? undefined,
    expiry_date: teacher.google_token_expires_at
      ? new Date(teacher.google_token_expires_at).getTime()
      : undefined,
  });

  // Only refresh if we have a refresh token AND the access token is expiring soon.
  if (!accessValid && refreshToken) {
    const { credentials } = await client.refreshAccessToken();
    if (!credentials.access_token) {
      throw new GoogleAuthError("Token refresh returned no access_token.");
    }
    const newExpiresAt = credentials.expiry_date
      ? new Date(credentials.expiry_date).toISOString()
      : new Date(Date.now() + 55 * 60 * 1000).toISOString();
    // Encrypt-on-write. M6.22 Phase 0b; plaintext columns dropped by
    // migration 20260524100000.
    await admin
      .from("teachers")
      .update({
        google_access_token_encrypted: encryptSecret(credentials.access_token),
        google_token_expires_at: newExpiresAt,
        ...(credentials.refresh_token
          ? {
              google_refresh_token_encrypted: encryptSecret(
                credentials.refresh_token,
              ),
            }
          : {}),
      })
      .eq("id", teacherId);
    client.setCredentials(credentials);
  }

  return client;
}
