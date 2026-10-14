"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Open-modal stack, outermost first. Every mounted Modal registers here so that
 * Escape only closes the TOPMOST one — without this, a modal opened from inside
 * another modal (e.g. the invoice preview's cost-breakdown) would close both on
 * a single Escape, discarding the parent's unsaved edits.
 */
const modalStack: string[] = [];

/**
 * Canonical modal shell. API matches production's prior `shared.tsx` Modal so existing
 * call sites are drop-in. Token-styled; adds Escape-to-close + body scroll lock,
 * traps Tab inside the dialog, moves focus in on open and back to the opener on
 * close, and labels the dialog by its title. Below `sm` it is a bottom sheet
 * (full width, flush with the bottom edge, up to the full viewport tall) rather
 * than a card floating above the keyboard. Safe to nest: the topmost modal
 * paints above and owns Escape.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  onClose,
  children,
  wide,
  extraWide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  extraWide?: boolean;
}) {
  const modalId = useId();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    modalStack.push(modalId);
    return () => {
      const i = modalStack.indexOf(modalId);
      if (i !== -1) modalStack.splice(i, 1);
    };
  }, [modalId]);

  // Focus management: remember the opener, move focus to the first field (or
  // the panel itself), keep Tab inside, and hand focus back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(`${FOCUSABLE}:not([aria-label="Close"])`);
    (first ?? panel).focus({ preventScroll: true });
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || modalStack[modalStack.length - 1] !== modalId) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
      const firstEl = items[0], lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      opener?.focus?.({ preventScroll: true });
    };
  }, [modalId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalStack[modalStack.length - 1] === modalId) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, modalId]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`bg-surface border border-line-strong rounded-lg max-sm:rounded-b-none shadow-xl w-full ${
          extraWide ? "max-w-5xl" : wide ? "max-w-2xl" : "max-w-md"
        } max-h-[100dvh] sm:max-h-[90dvh] max-sm:pb-[env(safe-area-inset-bottom,0px)] flex flex-col outline-none`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-line shrink-0">
          <h3 id={titleId} className="text-sm font-semibold text-primary">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn-secondary"
          >
            <span aria-hidden>×</span>
          </button>
        </div>
        <div className="p-5 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
}

/** Labeled form field. */
export function Field({
  label,
  required,
  children,
  hint,
}: {
  label: ReactNode;
  required?: boolean;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs text-secondary mb-1">
        {label}
        {required && <span className="text-danger ml-0.5">*</span>}
        {hint && <span className="text-faint ml-1.5">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

/** Standard modal footer: ghost Cancel + primary submit, using the canonical button classes. */
export function ModalActions({
  submitting,
  onCancel,
  label,
  disabled,
}: {
  submitting: boolean;
  onCancel: () => void;
  label: string;
  /** Disable submit for a reason other than in-flight (e.g. a client-side validation error). */
  disabled?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2 pt-2 border-t border-line mt-4">
      <button type="button" onClick={onCancel} className="btn-secondary">
        Cancel
      </button>
      <button type="submit" disabled={submitting || disabled} className="btn-primary">
        {submitting ? "Saving…" : label}
      </button>
    </div>
  );
}
