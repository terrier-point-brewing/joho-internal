/**
 * Reconciliation state of a draft recount, as the Shipments tab reports it.
 *
 * A draft-restock keg swap books barrel excise immediately. When there is no
 * cold-storage keg to deduct, the export row is written batchless and flagged
 * `is_phantom` — an open alert the Export Bay panel counts. From there it can
 * end two ways, and only one of them clears the batchless state:
 *
 * - RESOLVED against a keg lot: `reconcilePhantom` writes both `batch_id` and
 *   `alert_acknowledged_at`, so the row gains a batch and reads normally.
 * - DISMISSED as genuinely stockless: only `alert_acknowledged_at` is written.
 *   `batch_id` stays null forever.
 *
 * That second path is why this module exists. Export Bay stops counting a
 * dismissed alert, so without a state of its own the row would sit on the
 * Shipments tab as a bare, permanent "Unknown" while Export Bay reported
 * "All reconciled" — two views of one ledger disagreeing. `no_stock` names the
 * settled outcome so the row is explained rather than merely unlabelled.
 */
export type ReconcileState = "unreconciled" | "no_stock" | null;

/** The fields of an export row that determine its reconciliation state. */
export interface ReconcilableRow {
  is_phantom: boolean | null;
  alert_acknowledged_at: string | null;
  /** Null when no batch is linked — the defining trait of an open phantom. */
  brew_batches: { id: string; beer_name: string; batch_number: string } | null;
}

/**
 * State for a single export row. Non-phantom rows and resolved phantoms (which
 * carry a batch) have nothing to report.
 */
export function rowReconcileState(row: ReconcilableRow): ReconcileState {
  if (!row.is_phantom) return null;
  if (row.brew_batches) return null;
  return row.alert_acknowledged_at ? "no_stock" : "unreconciled";
}

/** Unreconciled outranks dismissed outranks nothing-to-say. */
const RANK: Record<string, number> = { unreconciled: 2, no_stock: 1 };

/**
 * Worse of two states. The Shipments tab collapses many rows into one product
 * line, and a single open alert has to survive that collapse — otherwise a
 * dismissed sibling row would mask it.
 */
export function worseReconcileState(a: ReconcileState, b: ReconcileState): ReconcileState {
  return (RANK[b ?? ""] ?? 0) > (RANK[a ?? ""] ?? 0) ? b : a;
}
