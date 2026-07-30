// Diffs a normalized manual-entry form value against the record it's editing
// and produces a TRUE SPARSE PATCH body for PATCH /api/finance/manual-entries
// (app/api/finance/manual-entries/route.ts) — only changed fields, plus the
// known kind-switch wrinkle documented there and in the Task 4 brief:
//
//   A PATCH that changes `entryKind` without ALSO explicitly nulling the
//   abandoned kind's date fields fails validation with a 400.
//
// So a kind switch always sends the new kind's dates AND explicit `null`s
// for the other kind's date fields, in the same PATCH body.

import type { ManualEntryInput, ManualEntryRecord } from "./manualEntries";

/** Sparse-PATCH body — mirrors the API route's `ManualEntryPatchBody`. */
export type ManualEntryPatch = { id: string } & Partial<{
  entryKind: ManualEntryInput["entryKind"];
  chartOfAccountsId: string;
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
  amountCents: number;
  label: string | null;
  note: string | null;
}>;

/**
 * `next` must already be a fully-normalized, validated `ManualEntryInput`
 * (e.g. its `asOfDate` already snapped to month end). Returns the minimal
 * patch that carries `existing` to `next`; a patch of just `{ id }` means
 * nothing changed.
 */
export function buildManualEntryPatch(
  existing: ManualEntryRecord,
  next: ManualEntryInput,
): ManualEntryPatch {
  const patch: ManualEntryPatch = { id: existing.id };

  if (next.entryKind !== existing.entryKind) {
    patch.entryKind = next.entryKind;
    if (next.entryKind === "flow") {
      patch.startDate = next.startDate;
      patch.endDate = next.endDate;
      patch.asOfDate = null;
    } else {
      patch.asOfDate = next.asOfDate;
      patch.startDate = null;
      patch.endDate = null;
    }
  } else if (next.entryKind === "flow") {
    if (next.startDate !== existing.startDate) patch.startDate = next.startDate;
    if (next.endDate !== existing.endDate) patch.endDate = next.endDate;
  } else {
    if (next.asOfDate !== existing.asOfDate) patch.asOfDate = next.asOfDate;
  }

  if (next.chartOfAccountsId !== existing.chartOfAccountsId) {
    patch.chartOfAccountsId = next.chartOfAccountsId;
  }
  if (next.amountCents !== existing.amountCents) {
    patch.amountCents = next.amountCents;
  }
  const nextLabel = next.label ?? null;
  if (nextLabel !== existing.label) {
    patch.label = nextLabel;
  }

  return patch;
}
