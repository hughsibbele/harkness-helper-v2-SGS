export type GrantAdminResult =
  | { ok: true }
  | { ok: false; message: string };

export type RevokeAdminResult =
  | { ok: true }
  | { ok: false; message: string };
