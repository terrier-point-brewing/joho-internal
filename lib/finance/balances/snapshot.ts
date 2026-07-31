// Balance-sheet monthly snapshot service. For a given period_end, resolves
// every active balance_sheet_account_sources row through the registered
// provider (lib/finance/balances/registry.ts), sums each account's
// non-null provider results, and upserts gl_account_balances.
//
// An account can have SEVERAL providers (composite PK on
// balance_sheet_account_sources) -- e.g. GL 2220 is taxAccrual PLUS
// transactionPostings -- so this sums every active provider's non-null
// result per account and records each contribution by provider key.
//
// All-null (every provider for an account returns null) writes NO ROW AT
// ALL: the account must read as unsourced, not as a spurious $0.
//
// Unlike lib/finance/autoMap.ts's fill-nulls-only convention, a derived
// balance stays recomputable while the month is open -- an existing
// non-frozen row is updated in place. A frozen row (is_frozen = true) is
// NEVER rewritten.
//
// The decision logic lives entirely in the pure resolveSnapshotWrites; the
// IO wrapper (snapshotPeriod) only fetches, calls providers, and writes.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { monthEnd } from "@/lib/finance/manualEntries";
import { getProvider } from "./registry";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface SnapshotResult {
  written: number;
  skipped: number;
  errors: string[];
}

interface SourceRow {
  chart_of_accounts_id: string;
  provider_key: string;
  config: Record<string, unknown> | null;
}

interface ExistingRow {
  chart_of_accounts_id: string;
  is_frozen: boolean;
}

/**
 * Pure. `sources` names every active (coaId, providerKey) pair for the
 * period; `results` carries each pair's already-computed provider result,
 * keyed `${coaId}:${providerKey}` (a missing key -- e.g. an unregistered
 * provider the IO layer skipped calling -- is treated exactly like a null
 * result: no contribution, never a thrown error). `existing` carries the
 * current gl_account_balances row (if any) per coaId for this period.
 */
export function resolveSnapshotWrites(
  sources: { coaId: string; providerKey: string }[],
  results: Map<string, number | null>,
  existing: Map<string, { isFrozen: boolean }>,
): { coaId: string; balanceCents: number; contributions: Record<string, number> }[] {
  const byCoa = new Map<string, { coaId: string; providerKey: string }[]>();
  for (const source of sources) {
    const bucket = byCoa.get(source.coaId);
    if (bucket) bucket.push(source);
    else byCoa.set(source.coaId, [source]);
  }

  const writes: { coaId: string; balanceCents: number; contributions: Record<string, number> }[] = [];

  for (const [coaId, coaSources] of byCoa) {
    if (existing.get(coaId)?.isFrozen) continue;

    const contributions: Record<string, number> = {};
    let total = 0;
    let hasContribution = false;

    for (const source of coaSources) {
      const value = results.get(`${source.coaId}:${source.providerKey}`);
      if (value === null || value === undefined) continue;
      contributions[source.providerKey] = value;
      total += value;
      hasContribution = true;
    }

    if (!hasContribution) continue;
    writes.push({ coaId, balanceCents: total, contributions });
  }

  return writes;
}

/**
 * Computes and writes the monthly snapshot for `periodEnd`. Reads every
 * active balance_sheet_account_sources row, resolves each provider from the
 * registry, runs it, and applies resolveSnapshotWrites's decisions.
 * A source naming a provider key not in the registry is skipped (never
 * thrown) and reported in `errors`; a provider that throws mid-compute is
 * likewise isolated so one bad source can't abort the whole run.
 */
export async function snapshotPeriod(supabase: AdminClient, periodEnd: string): Promise<SnapshotResult> {
  const errors: string[] = [];

  const { data: sourceRows, error: sourcesError } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id, provider_key, config")
    .eq("active", true);
  if (sourcesError) throw new Error(sourcesError.message);

  const sources = ((sourceRows ?? []) as SourceRow[]).map((r) => ({
    coaId: r.chart_of_accounts_id,
    providerKey: r.provider_key,
    config: r.config ?? {},
  }));

  const results = new Map<string, number | null>();
  // Accounts where a provider THREW. These must not be written at all.
  //
  // A throw leaves its key absent from `results`, and resolveSnapshotWrites
  // treats an absent key exactly like null -- so without this set, a transient
  // 5xx on one provider silently writes the OTHER providers' partial sum over a
  // previously-correct snapshot. GL 2220 is the worked example: if
  // transactionPostings fails while taxAccrual succeeds, the account would be
  // stored as -291,519 instead of 103,964, with nothing to indicate the figure
  // is half a balance. A stale-but-correct row beats a fresh-but-partial one.
  const failedAccounts = new Set<string>();

  for (const source of sources) {
    const provider = getProvider(source.providerKey);
    if (!provider) {
      errors.push(`Unknown balance provider "${source.providerKey}" for account ${source.coaId}`);
      failedAccounts.add(source.coaId);
      continue;
    }
    try {
      const value = await provider.compute({
        supabase,
        periodEnd,
        coaId: source.coaId,
        config: source.config,
      });
      results.set(`${source.coaId}:${source.providerKey}`, value);
    } catch (err) {
      errors.push(
        `Provider "${source.providerKey}" failed for account ${source.coaId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failedAccounts.add(source.coaId);
    }
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("gl_account_balances")
    .select("chart_of_accounts_id, is_frozen")
    .eq("period_end", periodEnd);
  if (existingError) throw new Error(existingError.message);

  const existing = new Map<string, { isFrozen: boolean }>(
    ((existingRows ?? []) as ExistingRow[]).map((r) => [r.chart_of_accounts_id, { isFrozen: r.is_frozen }]),
  );

  const writes = resolveSnapshotWrites(
    sources.map(({ coaId, providerKey }) => ({ coaId, providerKey })),
    results,
    existing,
  );

  let written = 0;
  for (const write of writes) {
    // Skip any account whose providers did not all succeed -- writing it would
    // persist a partial sum as if it were a whole balance. Already reported in
    // `errors` at the point of failure.
    if (failedAccounts.has(write.coaId)) continue;
    const { error } = await supabase.from("gl_account_balances").upsert(
      {
        chart_of_accounts_id: write.coaId,
        period_end: periodEnd,
        balance_cents: write.balanceCents,
        contributions: write.contributions,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "chart_of_accounts_id,period_end" },
    );
    if (error) {
      errors.push(`Failed writing account ${write.coaId}: ${error.message}`);
      continue;
    }
    written++;
  }

  const consideredAccounts = new Set(sources.map((s) => s.coaId)).size;
  const skipped = Math.max(consideredAccounts - written, 0);

  return { written, skipped, errors };
}

/**
 * gl_account_balances for the given "YYYY-MM" months, keyed coaId -> { month:
 * cents }, for Task 4's amountCentsByMonth consumption. `months` is mapped to
 * each month's period_end (always a month end) via monthEnd -- gl_account_balances
 * rows are only ever written on a month-end date.
 */
export async function fetchBalances(
  supabase: SupabaseClient,
  months: string[],
): Promise<Map<string, Record<string, number>>> {
  const map = new Map<string, Record<string, number>>();
  if (months.length === 0) return map;

  const periodEnds = months.map((month) => monthEnd(`${month}-01`));

  const { data, error } = await supabase
    .from("gl_account_balances")
    .select("chart_of_accounts_id, period_end, balance_cents")
    .in("period_end", periodEnds);
  if (error) throw new Error(error.message);

  for (const row of (data ?? []) as { chart_of_accounts_id: string; period_end: string; balance_cents: number }[]) {
    const monthKey = row.period_end.slice(0, 7);
    const bucket = map.get(row.chart_of_accounts_id);
    if (bucket) bucket[monthKey] = row.balance_cents;
    else map.set(row.chart_of_accounts_id, { [monthKey]: row.balance_cents });
  }

  return map;
}

/** Sets is_frozen = true for every gl_account_balances row of `periodEnd`. A frozen row is never recomputed by snapshotPeriod again. */
/**
 * Reopen a frozen period so its balances recompute on the next snapshot run.
 *
 * Freezing was previously a one-way door: there was no unfreeze anywhere, so a
 * period frozen in error -- which the day-one freeze bug did to whatever month
 * preceded the first cron run -- stayed wrong forever, with resolveSnapshotWrites
 * skipping it on every subsequent pass. An operation that can be performed by
 * accident needs an inverse.
 */
export async function unfreezePeriod(supabase: AdminClient, periodEnd: string): Promise<void> {
  const { error } = await supabase
    .from("gl_account_balances")
    .update({ is_frozen: false })
    .eq("period_end", periodEnd);
  if (error) throw new Error(error.message);
}

export async function freezePeriod(supabase: AdminClient, periodEnd: string): Promise<void> {
  const { error } = await supabase
    .from("gl_account_balances")
    .update({ is_frozen: true })
    .eq("period_end", periodEnd);
  if (error) throw new Error(error.message);
}
