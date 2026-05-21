export type PrepareDiscussionUploadResult =
  | {
      ok: true;
      storagePath: string;
      signedUploadUrl: string;
      token: string;
    }
  | { ok: false; message: string };

export type FinalizeDiscussionResult =
  | { ok: true; discussionId: string }
  | { ok: false; message: string };
