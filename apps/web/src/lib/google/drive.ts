// Google Drive helpers — folder creation + audio file upload.

import { google, type Auth, type drive_v3 } from "googleapis";
import { Readable } from "node:stream";

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
