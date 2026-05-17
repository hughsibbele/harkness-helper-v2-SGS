export type SaveToDriveResult =
  | {
      ok: true;
      links: Array<{
        kind: "audio" | "transcript" | "summary" | "folder";
        webViewLink: string;
      }>;
    }
  | { ok: false; message: string };
