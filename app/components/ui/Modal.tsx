"use client";

import { useEffect, useId, type ReactNode } from "react";

/**
 * Open-modal stack, outermost first. Every mounted Modal registers here so that
 * Escape only closes the TOPMOST one — without this, a modal opened from inside
 * another modal (e.g. the invoice preview's cost-breakdown) would close both on
 * a single Escape, discarding the parent's unsaved edits.
 */
const modalStack: string[] = [];

/**
 * Canonical modal shell. API matches production's prior `shared.tsx` Modal so existing
 * call sites are drop-in. Token-styled; adds Escape-to-close + body scroll lock.
 * Safe to nest: the topmost modal paints above and owns Escape.
 */
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

  useEffect(() => {
    modalStack.push(modalId);
    return () => {
      const i = modalStack.indexOf(modalId);
      if (i !== -1) modalStack.splice(i, 1);
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
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`bg-surface border border-line-strong rounded-lg shadow-xl w-full ${
          extraWide ? "max-w-5xl" : wide ? "max-w-2xl" : "max-w-md"
        } max-h-[90vh] flex flex-col`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <h3 className="text-sm font-semibold text-primary">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-body text-lg leading-none"
          >
            ×
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
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
