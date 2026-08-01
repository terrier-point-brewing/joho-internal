/**
 * Methods — the unit a user actually selects for a balance-sheet account.
 *
 * ── Why this layer exists ────────────────────────────────────────────────────
 * The provider layer (../registry.ts) is atomic: one provider computes one
 * number from one source. That is the right shape for CODE and the wrong shape
 * for a DROPDOWN, because most accounts need several providers together and
 * picking a subset silently produces a wrong balance rather than an error.
 *
 * GL 2310 is the standing proof. `tipAccrual` books tips COLLECTED; the payouts
 * that settle the liability arrive as ordinary expenses and are picked up by
 * `transactionPostings`. With the accrual alone the account read -577,257
 * instead of -72,397 -- an eight-fold overstatement that shipped to production
 * and was only caught by a parity capture. The same trap sits under 2220 (tax
 * accrued vs tax paid) and 1100 (open invoices vs direct postings).
 *
 * A method bundles those providers into one selectable thing, so "accrual
 * without payments" is no longer a state a user can reach.
 *
 * ── Methods do not compute ───────────────────────────────────────────────────
 * A method is composition plus human-readable metadata. Every step still
 * executes through the EXISTING provider registry -- this layer deliberately
 * adds no second way to compute a balance, and the provider modules were not
 * modified when it was introduced. Provider = how to compute. Method = what the
 * user picks, and what they are told it does.
 *
 * ── Step keys are a compatibility contract ───────────────────────────────────
 * A step's key defaults to its provider key and must stay identical to the
 * provider_key it replaces. gl_account_balances.contributions is keyed by that
 * string, so preserving it means historical snapshots stay readable, the
 * explainer panel can render months written before this refactor, and the
 * parity fixture compares equal with no translation.
 * See __fixtures__/goldenBalanceSheet.ts.
 */
import type { CoaAccountRef } from "../../financials/types";
import type { BalanceContext } from "../registry";
import { getProvider } from "../registry";

/**
 * The three top-level choices in Settings > Finance > Balance Sheet Accounts.
 * Mirrors the user-facing dropdown exactly rather than the provider layer's
 * derived/integration/manual split, which describes implementation rather than
 * intent.
 */
export type MethodKind = "manual" | "postings" | "calculation";

/** Display-only hint for the explainer panel's +/- column. */
export type StepDirection = "add" | "subtract" | "net";

export interface BalanceStep {
  /**
   * Stable identity, also the key this step's value is stored under in
   * gl_account_balances.contributions. Defaults to `providerKey`. Renaming one
   * silently orphans historical contributions instead of failing loudly, so
   * treat it as a published contract.
   */
  key?: string;
  /** Provider that actually computes this step. Must be registered. */
  providerKey: string;
  /** Short label for the explainer panel, sentence case. */
  label: string;
  /**
   * One plain-English sentence a non-technical user can check against their own
   * understanding of the account. Required, and enforced by test -- an
   * undescribed step makes the whole panel untrustworthy, because a reader
   * cannot tell whether the gap is "nothing to say" or "nobody wrote it down".
   */
  description: string;
  /** Where the number comes from, in plain words: "Square POS orders". */
  source: string;
  direction: StepDirection;
}

/** Connection state for an integration-backed method, shown in Settings. */
export interface ConnectionStatus {
  connected: boolean;
  /** e.g. "Ramp · Operating" — what it is connected TO. */
  label: string;
  /** ISO date of the last successful read, when known. */
  lastSyncedAt?: string | null;
  /** Populated when connected is false: what the operator must do. */
  remedy?: string;
}

export interface BalanceMethod {
  key: string;
  /** Sentence-case name shown in the dropdown. */
  label: string;
  kind: MethodKind;
  /** Plain-English one-liner heading the explainer panel. */
  summary: string;
  /** Filters which accounts may select this method. */
  appliesTo?: (coa: CoaAccountRef) => boolean;
  /** Ordered; rendered top to bottom in the panel. */
  steps: BalanceStep[];
  /** Integration-backed methods describe their connection for the Settings row. */
  describeConnection?: (config: Record<string, unknown>) => ConnectionStatus;
}

/** Resolved identity of a step — its key, defaulted from providerKey. */
export function stepKey(step: BalanceStep): string {
  return step.key ?? step.providerKey;
}

/**
 * Result of running a method. Deliberately three-valued: "every step returned
 * null" and "a step threw" are different situations with different correct
 * responses, and collapsing them is how a partial sum gets written over a
 * correct balance.
 *
 *   ok     -> write it
 *   empty  -> write NO ROW; the account reads as unsourced, not as a real $0
 *   failed -> write NO ROW and keep whatever is already stored; a
 *             stale-but-correct balance beats a fresh-but-partial one
 */
export type MethodOutcome =
  | { status: "ok"; cents: number; breakdown: Record<string, number> }
  | { status: "empty" }
  | { status: "failed"; errors: string[] };

const methodRegistry = new Map<string, BalanceMethod>();

/**
 * Register a method. Throws on a duplicate key: a silent overwrite would make
 * behavior depend on module import order, which is exactly the class of bug
 * this layer exists to prevent.
 */
export function registerMethod(m: BalanceMethod): void {
  if (methodRegistry.has(m.key)) {
    throw new Error(`Balance method already registered: ${m.key}`);
  }
  if (m.steps.length === 0) {
    throw new Error(`Balance method "${m.key}" declares no steps`);
  }
  const seen = new Set<string>();
  for (const step of m.steps) {
    const key = stepKey(step);
    if (seen.has(key)) {
      throw new Error(`Balance method "${m.key}" declares duplicate step "${key}"`);
    }
    seen.add(key);
  }
  methodRegistry.set(m.key, m);
}

export function getMethod(key: string): BalanceMethod | undefined {
  return methodRegistry.get(key);
}

export function listMethods(): BalanceMethod[] {
  return Array.from(methodRegistry.values());
}

/** Methods offerable for an account, honoring each method's appliesTo filter. */
export function methodsFor(coa: CoaAccountRef): BalanceMethod[] {
  return listMethods().filter((m) => !m.appliesTo || m.appliesTo(coa));
}

/** Test-only: clears the registry between tests. Not for use outside tests. */
export function __resetMethodRegistry(): void {
  methodRegistry.clear();
}

/**
 * Runs every step of a method through the provider registry and sums the
 * non-null results.
 *
 * Failure is per-METHOD, not per-step: if any step throws, or names a provider
 * that is not registered, the whole method fails and nothing is written. That
 * is intentional and is the single most important behavior here. Steps within a
 * method are two halves of one balance -- letting the surviving half through
 * would render GL 2220 as -297,509 (accruals only) instead of 97,974, with no
 * dash, no banner and no indication the figure is half an answer.
 */
export async function runMethod(method: BalanceMethod, ctx: BalanceContext): Promise<MethodOutcome> {
  const breakdown: Record<string, number> = {};
  const errors: string[] = [];
  let total = 0;
  let contributed = false;

  for (const step of method.steps) {
    const provider = getProvider(step.providerKey);
    if (!provider) {
      errors.push(`Method "${method.key}" step "${stepKey(step)}" names unregistered provider "${step.providerKey}"`);
      continue;
    }
    try {
      const value = await provider.compute(ctx);
      if (value === null || value === undefined) continue;
      breakdown[stepKey(step)] = value;
      total += value;
      contributed = true;
    } catch (err) {
      errors.push(
        `Method "${method.key}" step "${stepKey(step)}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (errors.length > 0) return { status: "failed", errors };
  if (!contributed) return { status: "empty" };
  return { status: "ok", cents: total, breakdown };
}
