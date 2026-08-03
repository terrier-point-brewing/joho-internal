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
// A month somebody has CLOSED is refused whole, before any of that: see
// periodClose.ts. is_frozen is per row, so on its own it would let an account
// configured after the close acquire a brand-new row inside a month already
// called final.
//
// The decision logic lives entirely in the pure resolveSnapshotWrites; the
// IO wrapper (snapshotPeriod) only fetches, calls providers, and writes.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { monthEnd } from "@/lib/finance/manualEntries";
import { todayLocalDate } from "@/lib/utils/datetime";
import { getProvider, createSharedComputeCache } from "./registry";
import type { BalanceContext } from "./registry";
import { getMethod, runMethod } from "./methods/registry";
import { mostRecentlyEndedMonthEnd } from "./periods";
import { readPeriodClose } from "./periodCloseState";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface SnapshotResult {
  written: number;
  skipped: number;
  errors: string[];
  /**
   * Accounts deliberately left out because this is an older month and one of
   * their steps can only answer about today. Not errors -- see
   * `dependsOnCurrentState` in registry.ts -- but reported so a blank row on a
   * backfilled month reads as "we declined to guess" rather than "nothing was
   * configured".
   */
  excluded: string[];
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

/** One declared source, as stored in balance_sheet_account_sources. */
export interface DeclaredSource {
  coaId: string;
  /** A METHOD key, or -- for rows written before the method migration -- a bare provider key. */
  providerKey: string;
  config: Record<string, unknown>;
}

/**
 * Everything resolveSnapshotWrites needs, with every method already expanded
 * into its individual steps.
 */
export interface ExpandedSources {
  /** One entry per STEP, keyed the way contributions are keyed. */
  sources: { coaId: string; providerKey: string }[];
  results: Map<string, number | null>;
  /** Accounts that must not be written at all this run. */
  failedAccounts: Set<string>;
  errors: string[];
  /** Accounts left out because a step of theirs cannot answer about a past month. */
  excluded: string[];
}

/**
 * Pure. Does this method reach for something only today can answer?
 *
 * Asked of the whole method rather than the failing step, because excluding
 * just the step would write the surviving half as if it were the whole balance
 * -- the exact GL 2220 failure this file's per-account rule exists to stop. GL
 * 1100 is the live case: `openInvoiceAr` plus `transactionPostings`, and
 * dropping only the first would report a historical A/R of whatever happened to
 * be posted directly, which for this business is usually nothing.
 */
function stepsDependOnCurrentState(stepKeys: string[]): boolean {
  return stepKeys.some((key) => getProvider(key)?.dependsOnCurrentState === true);
}

/**
 * Resolves each declared source and flattens it to per-step values.
 *
 * ── Why methods expand into steps rather than replacing them ─────────────────
 * A method (methods/registry.ts) is the unit a USER selects; a step is the unit
 * a CONTRIBUTION is stored under. Expanding here means resolveSnapshotWrites --
 * which is pure, well covered, and load-bearing -- needs no change at all, and
 * gl_account_balances.contributions keeps exactly the keys it already has. See
 * __fixtures__/goldenBalanceSheet.ts on why those keys are a contract.
 *
 * ── Legacy fallback, and why it makes deploy order irrelevant ────────────────
 * A source row naming something that is not a registered method falls through
 * to the provider registry. That is what lets the code ship before or after the
 * data migration with identical results: pre-migration, GL 2220 still carries
 * two rows ("taxAccrual", "transactionPostings") which resolve as one legacy
 * provider and one single-step method; post-migration it carries one row
 * ("salesTaxPayable") whose two steps produce the very same pair of
 * contributions. Neither ordering has a window where the statement goes blank.
 *
 * ── Failure is per-account ───────────────────────────────────────────────────
 * A step that throws, or a key matching neither a method nor a provider, marks
 * the whole ACCOUNT failed. resolveSnapshotWrites cannot distinguish "returned
 * null" from "blew up", so letting a failure through would write the surviving
 * half as if it were the whole balance -- GL 2220 stored as -297,509 rather
 * than 97,974, with nothing on screen to say it is half an answer. A
 * stale-but-correct row beats a fresh-but-partial one.
 *
 * ── Accounts resolve concurrently ────────────────────────────────────────────
 * They used to resolve one after another, and the balance sheet took six
 * seconds to draw because of it: thirteen accounts, no two of which read each
 * other's output, queued behind one another for 6.2s of the ~6.9s the whole
 * statement cost. Each account's answer depends only on its own declared
 * source, so they are all started at once and folded together below.
 */
export async function expandSources(
  supabase: AdminClient,
  periodEnd: string,
  declared: DeclaredSource[],
  /** True when `periodEnd` is older than the month currently being closed. */
  historical = false,
): Promise<ExpandedSources> {
  // One cache for the whole pass. Running the accounts concurrently is what
  // makes it necessary as well as possible: taxAccrual's collections scan is
  // the same 9.7k rows for GL 2220 and GL 2250, and without this both would now
  // run that scan simultaneously rather than merely twice.
  const shared = createSharedComputeCache();

  const outcomes = await Promise.all(
    declared.map((source) =>
      resolveDeclaredSource(
        { supabase, periodEnd, coaId: source.coaId, config: source.config, shared },
        source,
        historical,
      ),
    ),
  );

  // Folded in DECLARATION order, never completion order. `sources` fixes the
  // key order of gl_account_balances.contributions, and `errors`/`excluded` are
  // compared verbatim by expandSources.test.ts -- all three would otherwise
  // reshuffle with whichever provider happened to answer first.
  const sources: { coaId: string; providerKey: string }[] = [];
  const results = new Map<string, number | null>();
  const failedAccounts = new Set<string>();
  const errors: string[] = [];
  const excluded: string[] = [];

  declared.forEach((source, i) => {
    const outcome = outcomes[i];
    switch (outcome.kind) {
      case "excluded":
        excluded.push(source.coaId);
        failedAccounts.add(source.coaId);
        break;
      case "failed":
        errors.push(...outcome.errors);
        failedAccounts.add(source.coaId);
        break;
      case "empty":
        break;
      case "steps":
        for (const step of outcome.steps) {
          sources.push({ coaId: source.coaId, providerKey: step.providerKey });
          results.set(`${source.coaId}:${step.providerKey}`, step.cents);
        }
        break;
    }
  });

  return { sources, results, failedAccounts, errors, excluded: Array.from(new Set(excluded)) };
}

/** One declared source's verdict, in the shape expandSources folds. */
type SourceOutcome =
  | { kind: "steps"; steps: { providerKey: string; cents: number | null }[] }
  | { kind: "empty" }
  | { kind: "excluded" }
  | { kind: "failed"; errors: string[] };

/**
 * Resolves ONE declared source. Never rejects: `Promise.all` fails fast, so a
 * rejection here would throw away the twelve healthy accounts that finished
 * alongside the broken one -- which is the opposite of the per-account
 * isolation the caller's doc promises.
 */
async function resolveDeclaredSource(
  ctx: BalanceContext,
  source: DeclaredSource,
  historical: boolean,
): Promise<SourceOutcome> {
  try {
    const method = getMethod(source.providerKey);
    if (method) {
      // Checked before the method runs, not after: the point is not to ask.
      if (historical && stepsDependOnCurrentState(method.steps.map((s) => s.providerKey))) {
        return { kind: "excluded" };
      }
      const outcome = await runMethod(method, ctx);
      if (outcome.status === "failed") {
        return { kind: "failed", errors: outcome.errors.map((e) => `${e} (account ${source.coaId})`) };
      }
      if (outcome.status === "empty") return { kind: "empty" };
      return {
        kind: "steps",
        steps: Object.entries(outcome.breakdown).map(([providerKey, cents]) => ({ providerKey, cents })),
      };
    }

    // Legacy: a bare provider key from before the method migration.
    const provider = getProvider(source.providerKey);
    if (!provider) {
      return {
        kind: "failed",
        errors: [`Unknown balance method or provider "${source.providerKey}" for account ${source.coaId}`],
      };
    }
    if (historical && provider.dependsOnCurrentState) return { kind: "excluded" };

    const value = await provider.compute(ctx);
    return { kind: "steps", steps: [{ providerKey: source.providerKey, cents: value }] };
  } catch (err) {
    return {
      kind: "failed",
      errors: [
        `Provider "${source.providerKey}" failed for account ${source.coaId}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

/** Reads every active balance_sheet_account_sources row. */
export async function fetchDeclaredSources(supabase: AdminClient): Promise<DeclaredSource[]> {
  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id, provider_key, config")
    .eq("active", true);
  if (error) throw new Error(error.message);

  return ((data ?? []) as SourceRow[]).map((r) => ({
    coaId: r.chart_of_accounts_id,
    providerKey: r.provider_key,
    config: r.config ?? {},
  }));
}

/**
 * Computes and writes the monthly snapshot for `periodEnd`. Reads every active
 * source, expands each into its steps, and applies resolveSnapshotWrites's
 * decisions. A source naming an unknown method or provider is reported rather
 * than thrown, and a step that throws is isolated to its own account so one bad
 * source cannot abort the whole run.
 *
 * ── Backfilling an older month asks fewer questions ──────────────────────────
 * Only the most recently ended month was ever snapshotted, so anything before
 * 2026-06 is blank. Filling those in is safe for almost every provider -- they
 * filter by date and answer about the month asked for -- but not for one that
 * reads a CURRENT status. `openInvoiceAr` sums invoices open TODAY, so asked
 * about March it returns March's invoices still unpaid now: an understatement
 * with nothing in the number to reveal it.
 *
 * Whether this is a backfill is derived here rather than passed in, so no
 * caller can forget it and quietly write a wrong figure into a month nobody is
 * looking at. `todayIso` is injectable for tests only.
 */
export async function snapshotPeriod(
  supabase: AdminClient,
  periodEnd: string,
  opts: { todayIso?: string } = {},
): Promise<SnapshotResult> {
  const todayIso = opts.todayIso ?? todayLocalDate();

  // A closed month is refused whole, before anything is read.
  //
  // is_frozen alone was not enough. It is per ROW, and an account that gains a
  // source after the close has no row yet -- so it would be computed and
  // written into a month somebody had already signed off, silently changing a
  // balance sheet that had been called final. Checking the period first means
  // the close covers the accounts nobody had configured as well as the ones
  // they had, which is what "these books are final" actually claims.
  const closeState = await readPeriodClose(supabase, periodEnd);
  if (closeState?.closed) {
    return { written: 0, skipped: 0, errors: [], excluded: [] };
  }

  // Strictly older than the month being closed. The current close period is
  // handled exactly as it always has been -- this changes nothing about the
  // figures the balance sheet shows today.
  const historical = periodEnd < mostRecentlyEndedMonthEnd(todayIso);

  const declared = await fetchDeclaredSources(supabase);
  const { sources, results, failedAccounts, errors, excluded } = await expandSources(
    supabase,
    periodEnd,
    declared,
    historical,
  );

  const { data: existingRows, error: existingError } = await supabase
    .from("gl_account_balances")
    .select("chart_of_accounts_id, is_frozen")
    .eq("period_end", periodEnd);
  if (existingError) throw new Error(existingError.message);

  const existing = new Map<string, { isFrozen: boolean }>(
    ((existingRows ?? []) as ExistingRow[]).map((r) => [r.chart_of_accounts_id, { isFrozen: r.is_frozen }]),
  );

  const writes = resolveSnapshotWrites(sources, results, existing);

  let written = 0;
  for (const write of writes) {
    // Skip any account whose steps did not all succeed -- writing it would
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

  // Counted off DECLARED sources, not expanded steps: an account whose every
  // step returned null contributes no step rows at all, and it is precisely
  // that account -- considered but not written -- that "skipped" is reporting.
  const consideredAccounts = new Set(declared.map((s) => s.coaId)).size;
  const skipped = Math.max(consideredAccounts - written, 0);

  return { written, skipped, errors, excluded };
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

/**
 * Reopen a frozen period so its balances recompute on the next snapshot run.
 *
 * Freezing was previously a one-way door: there was no unfreeze anywhere, so a
 * period frozen in error -- which the day-one freeze bug did to whatever month
 * preceded the first cron run -- stayed wrong forever, with resolveSnapshotWrites
 * skipping it on every subsequent pass. An operation that can be performed by
 * accident needs an inverse.
 *
 * Call it through `reopenPeriod` (periodClose.ts) rather than directly: the
 * unfreeze is the mechanism, and the record of who reopened the month and why
 * is the part somebody reading the balance sheet next month actually needs.
 */
export async function unfreezePeriod(supabase: AdminClient, periodEnd: string): Promise<void> {
  const { error } = await supabase
    .from("gl_account_balances")
    .update({ is_frozen: false })
    .eq("period_end", periodEnd);
  if (error) throw new Error(error.message);
}

/**
 * Sets is_frozen = true for every gl_account_balances row of `periodEnd`.
 *
 * Only `closePeriod` calls this. It used to be reachable from the nightly cron
 * on a due date, which is how a month came to be marked final with nobody's
 * name on it; freezing is now a consequence of somebody closing the month, and
 * has no other trigger anywhere.
 */
export async function freezePeriod(supabase: AdminClient, periodEnd: string): Promise<void> {
  const { error } = await supabase
    .from("gl_account_balances")
    .update({ is_frozen: true })
    .eq("period_end", periodEnd);
  if (error) throw new Error(error.message);
}
