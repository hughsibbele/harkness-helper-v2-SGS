"use client";

import { createContext, useContext, useState } from "react";
import { AutoSaveStatusPill, type AutoSaveStatus } from "./AutoSaveStatusPill";

type DispatchContext = (status: AutoSaveStatus) => void;

const AutoSaveDispatchCtx = createContext<DispatchContext | null>(null);

/**
 * Shared auto-save status across all auto-saving forms on a page. Used
 * when a page hosts multiple independent editors (e.g. /admin/prompts
 * rendering one PromptEditor per purpose) — each editor dispatches via
 * `useAutoSaveDispatch()` and the single pill at the bottom-right
 * reflects whichever save fired most recently.
 */
export function AutoSaveProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<AutoSaveStatus>({ kind: "idle" });
  return (
    <AutoSaveDispatchCtx.Provider value={setStatus}>
      {children}
      <AutoSaveStatusPill status={status} />
    </AutoSaveDispatchCtx.Provider>
  );
}

export function useAutoSaveDispatch(): DispatchContext {
  const ctx = useContext(AutoSaveDispatchCtx);
  if (!ctx) {
    throw new Error(
      "useAutoSaveDispatch must be used inside <AutoSaveProvider>",
    );
  }
  return ctx;
}
