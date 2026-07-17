"use client";

import { type ReactNode } from "react";
import { Modal } from "./Modal";

/**
 * Shared confirmation dialog. Replaces native `window.confirm()`/`alert()` in
 * feature code so destructive/irreversible actions get a theme-aware, testable
 * prompt. Render conditionally on a "pending action" state; call `onConfirm`
 * to proceed and `onCancel` to dismiss. See the finance UI plan, finding H7.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` → red confirm button (destructive); `primary` → amber (benign). */
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="text-sm text-body">{message}</div>
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-line">
        <button type="button" onClick={onCancel} className="btn-secondary">
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={tone === "danger" ? "btn-danger" : "btn-primary"}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
