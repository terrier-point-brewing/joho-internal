import { normalizeQbSyncStatus, qbSyncLabel, type RampObject } from "@/lib/finance/qbSyncStatus";
import { QB_SYNC_CLS } from "../../lib/categoryColors";

/**
 * Compact pill showing whether Ramp has synced a row to QuickBooks. Renders
 * nothing when the state is unknown (e.g. a row imported before this feature,
 * not yet re-synced). Shared by the Expenses and Bank Ledger tabs.
 */
export default function QbSyncBadge({ status, rampObject }: { status: string | null; rampObject: RampObject }) {
  const state = normalizeQbSyncStatus(status);
  if (state === "unknown") return null;
  return (
    <span className={`px-1.5 py-0.5 rounded text-2xs font-medium ${QB_SYNC_CLS[state]}`}>
      {qbSyncLabel(status, rampObject)}
    </span>
  );
}

/**
 * The row-level export question is binary — is this already in QuickBooks or
 * not — so the filter collapses the badge's finer states to two buckets. `ready`
 * and `partial` count as "not synced" (not yet fully in QB).
 */
export function qbSyncFilterValue(status: string | null): "synced" | "not_synced" {
  return normalizeQbSyncStatus(status) === "synced" ? "synced" : "not_synced";
}

export const QB_SYNC_FILTER_OPTIONS = [
  { value: "synced", label: "In QuickBooks" },
  { value: "not_synced", label: "Not synced" },
];
