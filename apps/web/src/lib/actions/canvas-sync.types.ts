export type CanvasSyncResult =
  | {
      ok: true;
      courses: number;
      assignments: number;
      students: number;
      syncedAt: string;
    }
  | { ok: false; message: string };
