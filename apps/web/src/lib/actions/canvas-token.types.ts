// Types & constants for the Canvas-token actions. Lives outside the
// "use server" file because Server Action modules can only export async
// functions — non-function exports there silently invalidate the module.

export const EHS_CANVAS_HOST = "episcopalhighschool.instructure.com";

export type ConnectState =
  | { status: "idle" }
  | { status: "ok"; canvasUserName: string }
  | { status: "error"; message: string };
