/**
 * Which bank-ledger rows reach the general ledger, once an operator has had a
 * say in it.
 *
 * ── What already existed, and what was missing ───────────────────────────────
 * `bank_ledger.include_in_gl` is a per-ROW decision made by whatever
 * imported the row: Ramp's rows default true, Plaid writes its Chase rows false
 * (20260916090000_bank_ledger_plaid_source.sql). That is the right default and
 * it is why linking a bank cannot silently rewrite closed months.
 *
 * What it cannot be is the operator's control. A row flag can only describe
 * rows that have already arrived, so "start counting Chase" written as a
 * row rewrite would leave tomorrow's sync still excluded, and would have to be
 * re-run forever. The decision belongs one level up, as a standing rule the
 * readers consult, and that is what this module is.
 *
 * ── Precedence ───────────────────────────────────────────────────────────────
 * Most specific decision wins, falling back to what the importer decided:
 *
 *     counterparty rule  ->  bank-feed rule  ->  the row's own include_in_gl
 *
 * ── Why an empty rule set cannot move a reported figure ──────────────────────
 * This is the load-bearing property, and it is structural rather than careful.
 * `bank_ledger_gl_rules` holds nothing until a human moves a switch. With no
 * rules:
 *
 *   * applyTo() emits the single `.eq("include_in_gl", true)` predicate the
 *     readers already carried, character for character. Not a superset that
 *     happens to be equivalent -- the same call.
 *   * allows() falls straight through to `row.include_in_gl`, which every
 *     fetched row satisfies by construction, so nothing is dropped.
 *
 * loadRules() swallows its own failure for the same reason: a missing table, a
 * revoked grant or a network blip resolves to "no rules", which is "carry on
 * exactly as before" and not "the balance sheet is now empty".
 *
 * ── Why the split between SQL and JS ─────────────────────────────────────────
 * The feed-level part is a query predicate because a Chase import is up to two
 * years of history, and fetching all of it on every statement render to throw
 * it away would be a real cost. The counterparty part is a predicate over rows
 * already fetched because expressing "not this name on this feed" in PostgREST
 * means interpolating counterparty names into filter syntax, and those names
 * contain the brackets and commas that syntax is made of -- e.g. "TPB OPERATING
 * FUNDS (···· 4077)". Both halves come off the same object so a caller cannot
 * apply one and forget the other.
 */
import { normalizeCounterparty } from "@/lib/ramp";
import { memoizeByRef } from "@/lib/utils/memo";

export const BANK_LEDGER_GL_RULES_TABLE = "bank_ledger_gl_rules";

/**
 * The columns allows() needs. Readers must select these alongside their own.
 * Typed as plain `string` rather than the literal so PostgREST stops trying to
 * type-check the interpolated select at compile time -- with the literal it
 * recurses past TypeScript's instantiation depth limit.
 */
export const INCLUSION_COLUMNS: string = "source, counterparty_key, counterparty_name, include_in_gl";

export type RuleScope = "source" | "counterparty";

/** One operator decision, as stored. */
export interface GlRule {
  scope: RuleScope;
  source: string;
  /** Null for a whole-feed rule. */
  counterparty_key: string | null;
  included: boolean;
}

/** The parts of a ledger row the decision is made from. */
export interface InclusionFacts {
  source: string;
  counterparty_key: string | null;
  counterparty_name: string | null;
  include_in_gl: boolean;
}

/** The subset of a PostgREST builder applyTo needs. Structural, so tests satisfy it too. */
export interface InclusionFilterable {
  eq(column: string, value: unknown): unknown;
  or(filters: string): unknown;
}

/**
 * The counterparty half of a rule's identity.
 *
 * Ramp's rows carry `counterparty_key` already (20260727 backfilled it).
 * Plaid's carry only `counterparty_name`, because its importer has no
 * counterparty concept to normalise against. Deriving the key here rather than
 * backfilling the column means rows that have not synced yet resolve the same
 * way as rows that have, and it keeps this work clear of the importer's table.
 * normalizeCounterparty is the same function both the Ramp sync and the
 * 20260727 backfill used, so the two paths cannot produce different keys for
 * the same name.
 */
export function counterpartyKeyOf(row: { counterparty_key?: string | null; counterparty_name?: string | null }): string | null {
  if (row.counterparty_key) return row.counterparty_key;
  const derived = normalizeCounterparty(row.counterparty_name);
  return derived === "" ? null : derived;
}

/**
 * Feed names are written into a PostgREST filter string, so they are checked
 * against the shape a feed name actually has ('ramp', 'plaid') rather than
 * trusted. A name that could change the meaning of the filter is dropped, which
 * costs that feed its opt-in and never widens what is counted.
 */
const SAFE_SOURCE = /^[a-z0-9_-]+$/i;

/**
 * A resolved rule set, ready to filter a `bank_ledger` read.
 *
 * applyTo is generic in the builder without constraining it: writing
 * `T extends InclusionFilterable` makes TypeScript check that constraint
 * against PostgREST's fully-parameterised filter-builder type, which recurses
 * past its instantiation depth limit. The runtime shape is checked instead --
 * see the InclusionFilterable cast in the implementation, and the fake builder
 * the tests drive it with.
 */
export interface BankLedgerInclusion {
  /** Narrow a query to the rows that could possibly count. Always a superset of allows(). */
  applyTo<T>(query: T): T;
  /** The real decision for one row. */
  allows(row: InclusionFacts): boolean;
}

/**
 * Separator for the (source, counterparty) composite map key.
 *
 * A NUL cannot occur in either half -- Postgres rejects it in a text value --
 * so it cannot collide the way a hyphen or a colon could between, say,
 * ("ramp", "a:b") and ("ramp:a", "b").
 *
 * Written as an ESCAPE, never as a literal NUL byte in the source. A raw one
 * makes the whole file read as binary: grep and ripgrep skip it, diffs render
 * it unusably, and an editor or formatter can silently drop it -- which would
 * merge two counterparties' rules together with nothing failing.
 */
const KEY_SEPARATOR = "\u0000";

export function buildInclusion(rules: GlRule[]): BankLedgerInclusion {
  const bySource = new Map<string, boolean>();
  const byCounterparty = new Map<string, boolean>();
  for (const rule of rules) {
    if (rule.scope === "source") bySource.set(rule.source, rule.included);
    else if (rule.counterparty_key) byCounterparty.set(`${rule.source}${KEY_SEPARATOR}${rule.counterparty_key}`, rule.included);
  }

  // Feeds where SOMETHING has been switched on. A counterparty opt-in counts:
  // its rows have to be fetched before allows() can pick them out, and the
  // over-fetch it causes is bounded by a decision someone made on purpose.
  const optedIn = new Set<string>();
  for (const [source, included] of bySource) if (included) optedIn.add(source);
  for (const rule of rules) if (rule.scope === "counterparty" && rule.included) optedIn.add(rule.source);
  const optedInSafe = [...optedIn].filter((s) => SAFE_SOURCE.test(s)).sort();

  return {
    applyTo<T>(query: T): T {
      const q = query as InclusionFilterable;
      if (optedInSafe.length === 0) return q.eq("include_in_gl", true) as T;
      return q.or(`include_in_gl.eq.true,source.in.(${optedInSafe.join(",")})`) as T;
    },

    allows(row: InclusionFacts): boolean {
      const key = counterpartyKeyOf(row);
      if (key !== null) {
        const decided = byCounterparty.get(`${row.source}${KEY_SEPARATOR}${key}`);
        if (decided !== undefined) return decided;
      }
      const feed = bySource.get(row.source);
      if (feed !== undefined) return feed;
      return row.include_in_gl;
    },
  };
}

/** Minimal client shape, so this can be called from both the frozen financials path and the balances path. */
interface RuleReader {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown[] | null; error: unknown }>;
  };
}

/**
 * Read the standing rules. Any failure resolves to "no rules", which restores
 * the pre-rule behaviour rather than blanking a statement -- see the note at
 * the top of this file.
 */
export async function loadRules(supabase: RuleReader): Promise<GlRule[]> {
  try {
    const { data, error } = await supabase
      .from(BANK_LEDGER_GL_RULES_TABLE)
      .select("scope, source, counterparty_key, included");
    if (error || !Array.isArray(data)) return [];
    return data as GlRule[];
  } catch {
    return [];
  }
}

/**
 * Read the rules and resolve them in one step -- what every reader actually
 * wants.
 *
 * Memoized on the Supabase client's identity, because the balance sheet calls
 * this once per account per period and would otherwise re-read the same handful
 * of rows forty times over. createSupabaseAdminClient() returns a NEW client
 * every call, so the cache lives exactly as long as one piece of work: a rule
 * saved on the settings screen takes effect on the very next read, and a stale
 * rule set cannot outlive the request that read it.
 */
export const loadBankLedgerInclusion: (supabase: RuleReader) => Promise<BankLedgerInclusion> =
  memoizeByRef(async (supabase: RuleReader) => buildInclusion(await loadRules(supabase)));
