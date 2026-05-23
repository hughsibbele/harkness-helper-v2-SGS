"use client";

import { useCallback, useEffect, useRef } from "react";

export function isFormDirty(form: HTMLFormElement): boolean {
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked !== el.defaultChecked) return true;
      } else if (
        el.type !== "hidden" &&
        el.type !== "submit" &&
        el.type !== "button"
      ) {
        if (el.value !== el.defaultValue) return true;
      }
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLSelectElement) {
      for (const opt of Array.from(el.options)) {
        if (opt.selected !== opt.defaultSelected) return true;
      }
    }
  }
  return false;
}

/**
 * Auto-save trigger for a single <form>. Fires `save()` when:
 * - 800ms have elapsed since the last keystroke (debounced)
 * - focus leaves the form (blur saves immediately)
 * - the tab becomes hidden (covers tab close + switch)
 *
 * M6.22 Phase 3c — single-flight. If a `save()` is already in flight
 * when a new trigger fires, set a pending flag and re-fire `save()` once
 * the current call resolves. This prevents two parallel saves racing
 * each other in the server action — last-write-wins becomes
 * sequenced-write-wins. The caller's `save` must return a Promise so
 * we can chain on it; existing callers were already async via
 * useTransition, so this just makes the contract explicit.
 *
 * Mirrors the OE pattern (oral-examiner-v2-SGS commit cd69dd8). Set
 * the form to `onSubmit={(e) => e.preventDefault()}` so Enter inside
 * an input doesn't try to submit.
 */
export function useAutoSaveForm({
  formRef,
  save,
  debounceMs = 800,
  freshnessKey,
}: {
  formRef: React.RefObject<HTMLFormElement | null>;
  save: () => Promise<void> | void;
  debounceMs?: number;
  freshnessKey: string;
}) {
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    let timer: number | null = null;
    let inFlight: Promise<void> | null = null;
    let pendingAfter = false;

    async function runSave(): Promise<void> {
      if (!isFormDirty(form!)) return;
      if (inFlight) {
        // M6.22 Phase 3c — coalesce overlapping triggers. Whatever
        // edit happens between now and the in-flight resolution will
        // be picked up by exactly one follow-up call.
        pendingAfter = true;
        return;
      }
      const p = Promise.resolve(saveRef.current());
      inFlight = p.finally(() => {
        inFlight = null;
        if (pendingAfter) {
          pendingAfter = false;
          // re-fire on next microtask so any state updates from the
          // previous save (re-baselining defaultValues etc.) commit
          // before isFormDirty is consulted again.
          void Promise.resolve().then(() => {
            if (isFormDirty(form!)) void runSave();
          });
        }
      });
      await p;
    }

    function fire() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      void runSave();
    }

    function onInput() {
      if (!isFormDirty(form!)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(fire, debounceMs);
    }

    function onFocusOut(e: FocusEvent) {
      const next = e.relatedTarget as Node | null;
      if (next && form!.contains(next)) return;
      fire();
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") fire();
    }

    form.addEventListener("input", onInput);
    form.addEventListener("change", onInput);
    form.addEventListener("focusout", onFocusOut);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      form.removeEventListener("input", onInput);
      form.removeEventListener("change", onInput);
      form.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [formRef, debounceMs, freshnessKey]);
}

export function useFormDataSnapshot({
  formRef,
  onSave,
}: {
  formRef: React.RefObject<HTMLFormElement | null>;
  onSave: (fd: FormData) => void;
}) {
  return useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    onSave(new FormData(form));
  }, [formRef, onSave]);
}
