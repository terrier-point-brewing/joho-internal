/**
 * Retroactive auto-mapping. One home for "fill the account on already-ingested,
 * still-unmapped rows" across all four finance sources. Pure resolvers decide the
 * updates (unit-tested); thin IO wrappers fetch rows + rules and apply the writes.
 *
 * Every resolver is fill-nulls-only and never touches a manual pin — the same
 * convention the ingest paths and the (soon thin) manual-button routes follow.
 */

/** Bank-ledger rows: map from counterparty rules, preserving manual + existing. */
export function resolveBankBackfill(
  rows: { id: string; counterparty_key: string | null; mapping_source: string; chart_of_accounts_id: string | null }[],
  counterpartyRules: Map<string, string>,
): { id: string; chart_of_accounts_id: string }[] {
  const updates: { id: string; chart_of_accounts_id: string }[] = [];
  for (const row of rows) {
    if (row.mapping_source === "manual") continue;
    if (row.chart_of_accounts_id) continue;
    if (!row.counterparty_key) continue;
    const coaId = counterpartyRules.get(row.counterparty_key);
    if (coaId) updates.push({ id: row.id, chart_of_accounts_id: coaId });
  }
  return updates;
}
