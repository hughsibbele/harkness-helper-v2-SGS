// Google Docs helpers — create a native Doc with given title and body text.

import { google, type Auth } from "googleapis";
import type { DriveFileRef } from "./drive";

/**
 * Create a native Google Doc with the given title and body text, optionally
 * inside a parent folder. Two-step: Drive creates the empty doc → Docs API
 * inserts the body via batchUpdate.
 */
export async function createDoc(
  auth: Auth.OAuth2Client,
  title: string,
  body: string,
  parentFolderId: string | null,
): Promise<DriveFileRef> {
  const drive = google.drive({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });

  const created = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: "application/vnd.google-apps.document",
      parents: parentFolderId ? [parentFolderId] : undefined,
    },
    fields: "id, webViewLink",
  });
  if (!created.data.id || !created.data.webViewLink) {
    throw new Error("Drive doc create returned incomplete data.");
  }
  const docId = created.data.id;

  if (body.trim().length > 0) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: body,
            },
          },
        ],
      },
    });
  }

  return { id: docId, webViewLink: created.data.webViewLink };
}
