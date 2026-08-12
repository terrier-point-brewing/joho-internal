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
import { readStatedBalanceCents } from "../providers/manualBalance";
import { STATED_BALANCE_KEY } from "../statedBalanceKey";

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
 *
 * ── Why Ramp appears twice ───────────────────────────────────────────────────
 * `ramp` is the treasury cash Ramp HOLDS for you; `rampCard` is what you OWE on
 * the Ramp cards. Same company, same credentials, and every other thing a
 * connection is asked about differs: what you pick from (a list of treasury
 * accounts vs the card programme itself), which endpoint answers, whether a
 * past date can be re-asked for, and therefore whether the daily capture has to
 * run. `planCaptures` selects work BY PROVIDER, so folding the two together
 * would have had the card capture write its figure onto GL 1030 as well.
 */
export type ConnectionProvider = "ramp" | "rampCard" | "plaid" | "square";

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
   *
   * Two keys are read BY NAME outside the panel and are therefore reserved.
   * `connectionId` is where every connection resolver looks; CLOSE_DUE_DAYS_KEY
   * is where the month-end close reads a per-account deadline. Both are held to
   * their name by the conformance suite.
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
  /**
   * A person in this business, stored as their user id.
   *
   * Same shape as `account` and for the same reason: the options are this
   * business's own staff and are unknowable when the method is written. It
   * exists because some accounts have no automatic source at all, and the only
   * thing setup can usefully record about those is WHO is on the hook for
   * supplying the figure -- see the manual entry method, and the per-person
   * alert the month-end close sends.
   */
  | (SetupFieldBase & { kind: "user" })
  /** A plain number stored in config. `unit` drives how the input is formatted. */
  | (SetupFieldBase & { kind: "number"; unit?: "cents" | "months" | "percent" | "plain" | "days" })
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
 * Whether this method needs a person to supply a figure FOR EACH MONTH before
 * that month can be called closed -- which is what raises a close task.
 *
 * ── Derived from the steps, not from the setup fields ────────────────────────
 * A step whose provider is `kind: "manual"` reads a `manual_entries` balance
 * dated to the exact month end being computed, and returns null until somebody
 * types one. That is the whole definition of "a human still owes this month a
 * number", and it is already declared -- once, on the provider.
 *
 * This previously asked whether the method declared an `operatorBalance` setup
 * field. That gave the right answer for the wrong reason, and the reason
 * mattered the moment manual entry stopped declaring one. `operatorBalance`
 * means "ask a person for a figure ONCE, during setup" -- which is genuinely
 * what Square needs, because its anchor has nowhere else to come from. Manual
 * entry's figure is not a setup step at all; it is the recurring monthly job.
 * Reading the close rule off a setup field therefore coupled "we asked at
 * setup" to "we must chase every month", and removing the field from manual
 * entry would have silently switched off the month-end chase for exactly the
 * accounts that exist to be chased -- no error, no task, no email.
 *
 * An unregistered provider answers false rather than throwing: this runs first
 * in the close cron, and refusing to create ANY task because one step names
 * something unknown is a worse failure than the unknown step.
 */
export function requiresMonthEndBalance(method: BalanceMethod): boolean {
  return method.steps.some((step) => getProvider(step.providerKey)?.kind === "manual");
}

/**
 * Where a per-account close deadline is stored, read BY NAME by closeTasks.ts.
 *
 * A method offers the override by declaring a number field under this key; an
 * account that leaves it blank falls back to the one global due day in
 * system_settings. Same arrangement as `connectionId`: one reserved key, held
 * to its name and its shape by the conformance suite, so the reader and the
 * declaration cannot drift apart.
 */
export const CLOSE_DUE_DAYS_KEY = "dueDaysAfterMonthEnd";

/**
 * The per-account close deadline an operator entered, in days after the month
 * end, or null to use the global default.
 *
 * Rejects anything that is not a positive whole number of days. A stored 0, a
 * negative, or a string that arrived from a form and never got parsed would
 * each produce a due date in or before the month being closed, which reads as
 * permanently overdue and alerts immediately.
 */
export function closeDueDaysOf(config: Record<string, unknown>): number | null {
  const raw = config[CLOSE_DUE_DAYS_KEY];
  const days = typeof raw === "string" ? Number(raw) : raw;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1) return null;
  return days;
}

/**
 * The person this account's balance is chased from, or null when nobody has
 * been named yet.
 *
 * Derived from the declared `user` field rather than from a key this module
 * knows, so a second method needing a responsible person gets alerts routed
 * without the alert code learning its name.
 */
export function responsibleUserIdOf(method: BalanceMethod, config: Record<string, unknown>): string | null {
  const field = method.setup?.find((f) => f.kind === "user");
  if (!field) return null;
  const id = config[field.key];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Resolved identity of a step — its key, defaulted from providerKey. */
export function stepKey(step: BalanceStep): string {
  return step.key ?? step.providerKey;
}

/**
 * Where a stated-balance override records itself in
 * gl_account_balances.contributions. Reserved: no method may declare a step
 * whose key collides with it, because the explainer panel reads it BY NAME.
 *
 * The value stored under it is the DIFFERENCE the override made, never the
 * stated figure itself. Contributions are summed to produce the account's
 * balance -- see resolveSnapshotWrites -- so storing the stated figure beside
 * the computed one would total the two together and report roughly double. As a
 * difference it sums correctly AND is the number a reader actually wants: how
 * far the feed was out.
 *
 * Declared in ../statedBalanceKey.ts so the balance sheet's client components
 * can name it without importing the provider registry.
 */
export { STATED_BALANCE_KEY };

/**
 * Whether an operator-stated balance REPLACES this method's figure for the
 * month it is dated.
 *
 * True only when every step reports a position somebody else keeps (see
 * `pointInTime` in ../registry.ts). That is a deliberately narrow door, and the
 * two kinds of method it shuts out are shut out for opposite reasons:
 *
 *   An ACCUMULATING method (sales tax, gift cards, retained earnings, plain
 *     postings) is corrected by typing the movement instead. It composes, and
 *     because the sum runs from inception the correction holds by itself in
 *     every later month. Overriding such an account for one month would fix
 *     that month and let the error return the next -- worse than useless,
 *     because it looks fixed.
 *
 *   A method that ALREADY reads a stated balance -- manual entry, and the
 *     Square anchor -- would have that figure applied twice, once by its own
 *     step and once here.
 *
 * An unregistered provider answers false rather than throwing, matching
 * requiresMonthEndBalance: this runs inside the snapshot, and refusing to
 * compute an account because one step names something unknown is a worse
 * failure than the unknown step.
 */
export function acceptsStatedBalance(method: BalanceMethod): boolean {
  return method.steps.every((step) => getProvider(step.providerKey)?.pointInTime === true);
}

/**
 * Which kinds of manual entry actually move an account on this method.
 *
 * The question the Manual Entries screen needs answered BEFORE somebody saves,
 * and the reason it needs answering is that picking the wrong kind used to be
 * silent: the row saved, appeared in the ledger with its label and its author,
 * and never touched the balance. Nothing failed and nothing said so.
 *
 * The two kinds are not interchangeable and neither is a fallback for the other:
 *
 *   "flow"    -- a movement. It composes with the feeds and, because the methods
 *                that read it sum from inception, it stays in force in every
 *                later month without being retyped.
 *   "balance" -- a whole position at a month end. Either it IS the account's
 *                answer (manual entry), or it anchors one (Square), or it
 *                restates a month a feed reported (see acceptsStatedBalance).
 *
 * Derived from what the steps DECLARE -- `readsManualFlow` on the provider, and
 * `kind: "manual"` for a provider that reads a stated balance -- so this cannot
 * drift from what the engine actually does when the entry is saved.
 */
export function manualEntryKindsFor(method: BalanceMethod): ("flow" | "balance")[] {
  const providers = method.steps.map((step) => getProvider(step.providerKey));
  const kinds: ("flow" | "balance")[] = [];
  if (providers.some((p) => p?.readsManualFlow === true)) kinds.push("flow");
  if (providers.some((p) => p?.kind === "manual") || acceptsStatedBalance(method)) kinds.push("balance");
  return kinds;
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
    // A step under this key would be summed into the balance AND read by the
    // explainer as the override row, which is one contribution claiming to be
    // two different things.
    if (key === STATED_BALANCE_KEY) {
      throw new Error(`Balance method "${m.key}" declares step "${key}", which is reserved for the stated-balance override`);
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
 *
 * ── The stated-balance override ──────────────────────────────────────────────
 * For the few methods that only ever relay a position somebody else keeps (see
 * acceptsStatedBalance), a balance an operator stated for THIS month end wins.
 * It is applied here rather than as a step because a step ADDS and this
 * REPLACES, and because doing it here keeps it off the step list -- which is
 * what stops it raising a month-end close task against every bank account, the
 * close checklist being driven by whether a method has a `kind: "manual"` step.
 *
 * A failed method is never overridden. "The feed broke" and "the operator
 * restated the figure" are different situations, and letting a stated balance
 * paper over a broken integration would retire the only signal that the
 * integration is broken.
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

  if (acceptsStatedBalance(method)) {
    const stated = await readStatedBalanceCents(ctx.supabase, ctx.coaId, ctx.periodEnd);
    if (stated !== null) {
      // Against the computed figure when there is one, and against nothing when
      // there is not. The second case is the one worth having: a month whose
      // reading was never captured has no figure at all, and stating it is the
      // only way that month ever gets one.
      breakdown[STATED_BALANCE_KEY] = contributed ? stated - total : stated;
      return { status: "ok", cents: stated, breakdown };
    }
  }

  if (!contributed) return { status: "empty" };
  return { status: "ok", cents: total, breakdown };
}
