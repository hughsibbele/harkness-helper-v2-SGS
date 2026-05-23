"use client";

// M6.22 Phase 3b — IndexedDB-backed crash recovery for MediaRecorder.
//
// Closes audit-auto-save.md C2: tab close mid-record discards the entire
// chunksRef.current array. A 90-minute Harkness recording lost to one
// accidental ⌘W is one keystroke away. With this module, every Blob the
// recorder emits on `ondataavailable` is persisted to IndexedDB keyed by
// (session_uuid, chunk_index). If the tab is reopened with orphan chunks
// still present, RecordingFlow surfaces a recovery banner.
//
// Cleanup contract: the SUCCESSFUL upload path calls `clearSession` after
// finalize lands. The discard path (teacher hits "Re-record" or
// dismisses the recovery banner) also calls `clearSession`. Anything
// that survives both is a crash artifact.
//
// IndexedDB is best-effort: we catch every error and fall back silently.
// The in-memory chunksRef is still authoritative for the current tab —
// IDB is only the backup for tab-crash / accidental-close recovery.

const DB_NAME = "harkness-helper.recordings";
const DB_VERSION = 1;
const STORE = "chunks";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: ["session_id", "chunk_index"],
        });
        store.createIndex("by_session", "session_id", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
  });
  // If the open promise fails, allow a retry on the next call.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

export type PersistedSession = {
  session_id: string;
  started_at: number;
  mime_type: string;
  chunk_count: number;
  approximate_bytes: number;
};

type ChunkRow = {
  session_id: string;
  chunk_index: number;
  started_at: number;
  mime_type: string;
  blob: Blob;
};

/**
 * Persist one chunk for a recording session. Best-effort: errors are
 * caught and reported via the optional onError callback so the recorder
 * can degrade gracefully (in-memory only) without throwing through the
 * MediaRecorder ondataavailable handler.
 */
export async function persistChunk(args: {
  session_id: string;
  chunk_index: number;
  started_at: number;
  mime_type: string;
  blob: Blob;
}): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(args satisfies ChunkRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IDB put aborted"));
    });
  } catch {
    // Storage full, private-mode Safari, or any other IDB unhappiness.
    // The current tab still has the chunk in memory — this is purely
    // crash insurance.
  }
}

export async function listOrphanSessions(): Promise<PersistedSession[]> {
  try {
    const db = await openDb();
    const rows: ChunkRow[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as ChunkRow[]);
      req.onerror = () => reject(req.error ?? new Error("IDB getAll failed"));
    });
    const bySession = new Map<string, PersistedSession>();
    for (const row of rows) {
      const existing = bySession.get(row.session_id);
      if (!existing) {
        bySession.set(row.session_id, {
          session_id: row.session_id,
          started_at: row.started_at,
          mime_type: row.mime_type,
          chunk_count: 1,
          approximate_bytes: row.blob.size,
        });
      } else {
        existing.chunk_count += 1;
        existing.approximate_bytes += row.blob.size;
      }
    }
    return [...bySession.values()].sort((a, b) => b.started_at - a.started_at);
  } catch {
    return [];
  }
}

export async function reconstructSession(
  session_id: string,
): Promise<{ blob: Blob; mime_type: string; chunk_count: number } | null> {
  try {
    const db = await openDb();
    const rows: ChunkRow[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const idx = tx.objectStore(STORE).index("by_session");
      const req = idx.getAll(IDBKeyRange.only(session_id));
      req.onsuccess = () => resolve(req.result as ChunkRow[]);
      req.onerror = () =>
        reject(req.error ?? new Error("IDB reconstruct failed"));
    });
    if (rows.length === 0) return null;
    rows.sort((a, b) => a.chunk_index - b.chunk_index);
    const mime_type = rows[0]!.mime_type;
    const blob = new Blob(
      rows.map((r) => r.blob),
      { type: mime_type },
    );
    return { blob, mime_type, chunk_count: rows.length };
  } catch {
    return null;
  }
}

export async function clearSession(session_id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const idx = tx.objectStore(STORE).index("by_session");
      const req = idx.openCursor(IDBKeyRange.only(session_id));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB clear failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IDB clear aborted"));
    });
  } catch {
    // ignore
  }
}
