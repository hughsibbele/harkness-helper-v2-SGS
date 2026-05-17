export type UploadDiscussionResult =
  | { ok: true; discussionId: string }
  | { ok: false; message: string };
