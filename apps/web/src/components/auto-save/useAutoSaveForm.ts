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
  save: () => void;
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

    function fire() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (!isFormDirty(form!)) return;
      saveRef.current();
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
