"use client";

import { BatchStatus } from "../types";
import { CATEGORY_BADGE_CLASS } from "../lib/categoryColors";

// Re-export the canonical shared shell so all production modals get the same chrome
// (overlay, token surfaces, Escape-to-close, scroll lock) without changing call sites.
export { Modal, Field, ModalActions } from "@/app/components/ui/Modal";

export const BREWHOUSE_BBL = 20;

export const BATCH_STATUSES: { value: BatchStatus; label: string; color: string }[] = [
  { value: "planning",     label: "Planning",     color: CATEGORY_BADGE_CLASS.muted },
  { value: "brewing",      label: "Brewing",      color: CATEGORY_BADGE_CLASS.amber },
  { value: "fermenting",   label: "Fermenting",   color: CATEGORY_BADGE_CLASS.blue },
  { value: "conditioning", label: "Conditioning", color: CATEGORY_BADGE_CLASS.purple },
  { value: "complete",     label: "Complete",     color: CATEGORY_BADGE_CLASS.neutral },
];

export const STATUS_MAP = Object.fromEntries(
  BATCH_STATUSES.map((s) => [s.value, s])
) as Record<BatchStatus, typeof BATCH_STATUSES[number]>;

export function StatusBadge({ status }: { status: BatchStatus }) {
  const s = STATUS_MAP[status];
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-medium ${s?.color ?? ""}`}>
      {s?.label ?? status}
    </span>
  );
}
