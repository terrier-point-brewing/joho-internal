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

/**
 * Which external service a connection field links to.
 *
 * Lives here rather than in connections.ts so that module can import from this
 * one without a cycle.
 */
export type ConnectionProvider = "ramp" | "plaid" | "square";

/**
 * How an operator obtains something to connect.
 *
 *   discover  -- the server can list the candidates outright, because the app
 *                is already authenticated to the service (Ramp's treasury
 *                accounts, Square's locations).
 *   authorize -- the operator must sign in at the third party first, in their
 *                own browser, and only then does a candidate list exist
 *                (Plaid Link, which is how a bank credential is minted).
 */
export type ConnectFlow = "discover" | "authorize";

interface SetupFieldBase {
  /**
   * Where the answer is stored in `balance_sheet_account_sources.config`, and
   * the field's identity in the UI. Treat it as a published contract for the
   * same reason a step key is: renaming one silently unconfigures every account
   * already using this method rather than failing loudly.
   *
   * `operatorBalance` is the one kind whose answer does NOT live in config --
   * it is a `manual_entries` balance row, so an operator can edit it, the close
   * workflow can chase it and the audit trail exists. Its key names the field,
   * not a config slot.
   */
  key: string;
  /** Short label for the setup panel, sentence case. */
  label: string;
  /**
   * One plain-English sentence telling a non-technical operator what to supply
   * and why the calculation cannot run without it. Held to the same standard as
   * a step description, and enforced by the same conformance suite -- this copy
   * is what someone reads at the moment they are stuck.
   */
  help: string;
  /**
   * Set when the method can still produce a balance without this answer.
   * Defaults to required, because a setup field that does not block anything is
   * usually a setting rather than a setup step.
   */
  optional?: boolean;
}

/**
 * One thing an operator must supply before a method can compute.
 *
 * ── Why this is not "integration config" ─────────────────────────────────────
 * The obvious shape is a flag saying "this method reads an external service",
 * and that is what this layer had first. It does not survive contact with the
 * next calculation: a straight-line depreciation method needs a useful life and
 * an in-service date and no external service at all, and an opening-balance
 * method needs one figure and nothing else. Modelling setup as "connections"
 * would have sent each of those off to build its own screen, which is exactly
 * how three integrations ended up with three different ones.
 *
 * So the unit here is a FIELD, not an integration. A connection is one kind of
 * field. The Settings screen renders whatever a method declares, in order, and
 * a new calculation with new prerequisites is a declaration rather than a new
 * screen.
 */
export type SetupField =
  | (SetupFieldBase & {
      kind: "connection";
      provider: ConnectionProvider;
      connect: ConnectFlow;
    })
  /**
   * A figure only a person can supply, stored as a `manual_entries` balance row
   * dated to a month end. Declaring one is also what makes the month-end close
   * raise a task for this account -- see closeTasks.ts.
   */
  | (SetupFieldBase & { kind: "operatorBalance" })
  | (SetupFieldBase & { kind: "select"; options: { value: string; label: string }[] })
  /**
   * Another general-ledger account this one relates to, stored as its coa id.
   *
   * Distinct from `select` because the options are not knowable when the method
   * is written -- they are this business's own chart of accounts. `sections`
   * narrows what may be picked to the statement sections that make sense (bank
   * accounts for a sweep destination), so the field cannot be pointed at, say,
   * an expense account.
   *
   * The first prerequisite here with nothing to do with an external service,
   * and the reason setup is modelled as FIELDS rather than as connections.
   */
  | (SetupFieldBase & { kind: "account"; sections?: string[] })
  /** A plain number stored in config. `unit` drives how the input is formatted. */
  | (SetupFieldBase & { kind: "number"; unit?: "cents" | "months" | "percent" | "plain" })
  | (SetupFieldBase & { kind: "text" })
  | (SetupFieldBase & { kind: "date" });

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
  /**
   * What an operator must supply before this method can compute, in the order
   * they should be asked for it. Omit when the method needs nothing -- a
   * postings roll-up works the moment it is selected.
   *
   * Declaring a field is the ONLY thing a method does to get its setup handled.
   * From it, generically: Settings renders the field, stores the answer, tells
   * the operator what is still outstanding, and refuses to call the account
   * configured until every required field is answered. There is no
   * per-integration screen to write, and deliberately no second place a method
   * can be configured from.
   */
  setup?: SetupField[];
}

/** The connection field a method declares, if it has one. At most one is meaningful. */
export function connectionFieldOf(method: BalanceMethod): (SetupField & { kind: "connection" }) | undefined {
  return method.setup?.find((f): f is SetupField & { kind: "connection" } => f.kind === "connection");
}

/**
 * Which external service this method reads from, or undefined for a purely
 * internal calculation.
 *
 * DERIVED from the declared connection field rather than declared separately.
 * The two were once both spelled out, which is one fact in two places and
 * therefore one fact that can disagree with itself.
 */
export function connectionProviderOf(method: BalanceMethod): ConnectionProvider | undefined {
  return connectionFieldOf(method)?.provider;
}

/**
 * Whether this method needs a person to supply a figure before a period can be
 * called closed -- which is exactly the same question as "does it declare an
 * operatorBalance field".
 *
 * This replaced a `requiresCloseEntry` flag plus a hard-coded check for the
 * name "manualBalance". Both said the same thing the declaration now says once.
 */
export function requiresOperatorBalance(method: BalanceMethod): boolean {
  return method.setup?.some((f) => f.kind === "operatorBalance") ?? false;
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

  const setupKeys = new Set<string>();
  let connectionFields = 0;
  for (const field of m.setup ?? []) {
    if (setupKeys.has(field.key)) {
      throw new Error(`Balance method "${m.key}" declares duplicate setup field "${field.key}"`);
    }
    setupKeys.add(field.key);
    // More than one would make config.connectionId ambiguous, and the whole
    // resolution path -- resolveConnection, the daily capture planner, the
    // health line -- reads exactly that one key.
    if (field.kind === "connection" && ++connectionFields > 1) {
      throw new Error(`Balance method "${m.key}" declares more than one connection field`);
    }
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
