"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { AutoSaveStatusPill, type AutoSaveStatus } from "./AutoSaveStatusPill";

// M6.22 Phase 3c — per-key aggregation.
//
// Previously this Provider held a single AutoSaveStatus useState. When a
// page hosts multiple PromptEditors (`/admin/prompts` ships four), each
// editor dispatched into the same slot — and a quick "saved" from editor
// B silently overwrote a "save failed" from editor A. The pill green-
// washed real errors.
//
// New shape: each editor passes a stable `key` to its dispatch. The
// Provider keeps a Map<key, AutoSaveStatus> and renders ONE pill whose
// status is the aggregate, with this precedence:
//   1. any "saving"  → show "saving" (most recent wins for relative time)
//   2. any "error"   → show that error (most recent error wins)
//   3. all "saved"   → show "saved" (most recent at-time)
//   4. else          → idle (no pill)
//
// PromptEditor backward-compat: if the caller doesn't pass a key, we
// route into a synthetic "(default)" key so existing single-editor pages
// behave the same as before.

type DispatchContext = (key: string, status: AutoSaveStatus) => void;

const AutoSaveDispatchCtx = createContext<DispatchContext | null>(null);

const DEFAULT_KEY = "(default)";

export function AutoSaveProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [byKey, setByKey] = useState<Map<string, AutoSaveStatus>>(new Map());

  const dispatch = useCallback<DispatchContext>((key, status) => {
    setByKey((prev) => {
      const next = new Map(prev);
      next.set(key, status);
      return next;
    });
  }, []);

  const aggregate = useMemo<AutoSaveStatus>(() => {
    let anyError: Extract<AutoSaveStatus, { kind: "error" }> | null = null;
    let anySaving: Extract<AutoSaveStatus, { kind: "saving" }> | null = null;
    let latestSaved: Extract<AutoSaveStatus, { kind: "saved" }> | null = null;
    for (const status of byKey.values()) {
      if (status.kind === "saving") anySaving = status;
      else if (status.kind === "error") {
        // Most recent error wins for visibility — Map iteration order is
        // insertion order, so a later .set bumps it to the end.
        anyError = status;
      } else if (status.kind === "saved") {
        if (!latestSaved || status.at > latestSaved.at) latestSaved = status;
      }
    }
    if (anySaving) return anySaving;
    if (anyError) return anyError;
    if (latestSaved) return latestSaved;
    return { kind: "idle" };
  }, [byKey]);

  return (
    <AutoSaveDispatchCtx.Provider value={dispatch}>
      {children}
      <AutoSaveStatusPill status={aggregate} />
    </AutoSaveDispatchCtx.Provider>
  );
}

/**
 * Per-editor dispatch hook. The optional `key` arg identifies one editor
 * inside a multi-editor page (e.g. four PromptEditors on /admin/prompts).
 * Callers without a key route through a shared default slot — backward-
 * compat for single-editor pages.
 */
export function useAutoSaveDispatch(
  key: string = DEFAULT_KEY,
): (status: AutoSaveStatus) => void {
  const ctx = useContext(AutoSaveDispatchCtx);
  if (!ctx) {
    throw new Error(
      "useAutoSaveDispatch must be used inside <AutoSaveProvider>",
    );
  }
  return useCallback((status: AutoSaveStatus) => ctx(key, status), [ctx, key]);
}
