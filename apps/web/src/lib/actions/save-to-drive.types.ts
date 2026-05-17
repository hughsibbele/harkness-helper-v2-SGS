export type SaveToDriveResult =
  | {
      ok: true;
      links: Array<{ kind: "audio" | "transcript" | "folder"; webViewLink: string }>;
    }
  | { ok: false; message: string };
