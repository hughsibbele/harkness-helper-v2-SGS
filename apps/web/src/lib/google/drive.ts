// Google Drive helpers — folder creation, file upload, domain sharing,
// app-folder self-heal.

import { google, type Auth, type drive_v3 } from "googleapis";
import { Readable } from "node:stream";

const DOMAIN = "episcopalhighschool.org";

export type DriveFileRef = {
  id: string;
  webViewLink: string;
};

function client(auth: Auth.OAuth2Client): drive_v3.Drive {
  return google.drive({ version: "v3", auth });
}

/** Create a folder at the user's Drive root with the given name. */
export async function createFolder(
  auth: Auth.OAuth2Client,
  name: string,
): Promise<DriveFileRef> {
  const drive = client(auth);
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id, webViewLink",
  });
  if (!res.data.id || !res.data.webViewLink) {
    throw new Error("Drive folder create returned incomplete data.");
  }
  return { id: res.data.id, webViewLink: res.data.webViewLink };
}

/**
 * Share a Drive file/folder with every member of the configured Workspace
 * domain as a reader. Idempotent — Drive de-dupes on (type, role, domain).
 * Best-effort: a share failure on a folder shouldn't break the doc
 * creation that triggered it, so callers swallow the error.
 *
 * M7 invariant: every auto-created folder is org-shared by default so
 * the artifact stays accessible if the owning teacher's account ever
 * sunsets.
 */
export async function shareWithDomain(
  auth: Auth.OAuth2Client,
  fileId: string,
): Promise<void> {
  const drive = client(auth);
  await drive.permissions.create({
    fileId,
    requestBody: {
      type: "domain",
      role: "reader",
      domain: DOMAIN,
    },
    sendNotificationEmail: false,
  });
}

/**
 * Get or auto-create the per-app folder in the teacher's Drive root.
 *
 * Self-heals on 404 / trashed: when `currentFolderId` points at a folder
 * that no longer exists (teacher emptied trash, manually deleted),
 * returns a fresh folder. Caller persists the returned id back to the
 * teachers row.
 *
 * Always domain-shares on create (M7 invariant). Existing folders are
 * left alone — if a teacher pointed at an external folder via the M7.2
 * picker, we honor it.
 */
export async function getOrCreateAppFolder(
  auth: Auth.OAuth2Client,
  currentFolderId: string | null,
  appName: string,
): Promise<{ id: string; webViewLink: string; created: boolean }> {
  const drive = client(auth);

  if (currentFolderId) {
    try {
      const res = await drive.files.get({
        fileId: currentFolderId,
        fields: "id, webViewLink, trashed, mimeType",
      });
      const data = res.data;
      const isFolder =
        data.mimeType === "application/vnd.google-apps.folder";
      if (data.id && data.webViewLink && isFolder && !data.trashed) {
        return {
          id: data.id,
          webViewLink: data.webViewLink,
          created: false,
        };
      }
      // Stored id points at a non-folder, trashed file, or a doc — fall
      // through to recreate. Treat as the same case as 404.
    } catch (err) {
      // Drive returns 404 for missing files; anything else is an actual
      // failure we shouldn't paper over.
      const status = (err as { code?: number; status?: number })?.code
        ?? (err as { code?: number; status?: number })?.status;
      if (status !== 404) throw err;
    }
  }

  const created = await createFolder(auth, appName);
  await shareWithDomain(auth, created.id).catch(() => {
    // Domain-share is a polish; don't fail the create on it.
  });
  return { id: created.id, webViewLink: created.webViewLink, created: true };
}

/** Upload an audio blob to the given parent folder (or Drive root if null). */
export async function uploadAudio(
  auth: Auth.OAuth2Client,
  audio: {
    blob: Blob;
    filename: string;
    mimeType: string;
  },
  parentFolderId: string | null,
): Promise<DriveFileRef> {
  const drive = client(auth);
  const buffer = Buffer.from(await audio.blob.arrayBuffer());
  const res = await drive.files.create({
    requestBody: {
      name: audio.filename,
      mimeType: audio.mimeType,
      parents: parentFolderId ? [parentFolderId] : undefined,
    },
    media: {
      mimeType: audio.mimeType,
      body: Readable.from(buffer),
    },
    fields: "id, webViewLink",
  });
  if (!res.data.id || !res.data.webViewLink) {
    throw new Error("Drive audio upload returned incomplete data.");
  }
  return { id: res.data.id, webViewLink: res.data.webViewLink };
}
