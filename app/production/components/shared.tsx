"use client";

import { BatchStatus } from "../types";

export const BREWHOUSE_BBL = 20;

export const BATCH_STATUSES: { value: BatchStatus; label: string; color: string }[] = [
  { value: "planning",        label: "Planning",        color: "bg-zinc-700/60 text-zinc-300 border-zinc-600" },
  { value: "brewing",         label: "Brewing",         color: "bg-amber-900/50 text-amber-300 border-amber-700" },
  { value: "fermenting",      label: "Fermenting",      color: "bg-blue-900/50 text-blue-300 border-blue-700" },
  { value: "conditioning",    label: "Conditioning",    color: "bg-purple-900/50 text-purple-300 border-purple-700" },
  { value: "archived",        label: "Archived",        color: "bg-zinc-800/50 text-zinc-500 border-zinc-700" },
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

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div
        className={`bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl w-full ${
          wide ? "max-w-2xl" : "max-w-md"
        } max-h-[90vh] flex flex-col`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 shrink-0">
          <h3 className="text-sm font-medium text-zinc-100">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">
            ×
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  required,
  children,
  hint,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
        {hint && <span className="text-zinc-600 ml-1.5">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

export function ModalActions({
  submitting,
  onCancel,
  label,
}: {
  submitting: boolean;
  onCancel: () => void;
  label: string;
}) {
  return (
    <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800 mt-4">
      <button
        type="button"
        onClick={onCancel}
        className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
      >
        {submitting ? "Saving…" : label}
      </button>
    </div>
  );
}
