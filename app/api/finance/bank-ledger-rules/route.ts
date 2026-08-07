/**
 * The switches behind GL Mapping → Bank Feeds and the "In the books" column on
 * GL Mapping → Counterparties.
 *
 * GET answers "what would happen today": every feed in the bank ledger, how many
 * transactions it holds and over what dates, whether those transactions are
 * currently reaching the books, and whether that is the importer's default or a
 * decision somebody made. The counts matter — switching a feed on can bring two
 * years of history into closed months, and the operator should see the size of
 * that before they do it, not after.
 *
 * PUT records one decision, either way round. There is deliberately no "unset":
 * switching a feed back off stores false, which behaves the same as the
 * importer's own default and additionally survives that default changing.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  BANK_LEDGER_GL_RULES_TABLE,
  buildInclusion,
  counterpartyKeyOf,
  type GlRule,
} from "@/lib/finance/bankLedgerInclusion";
import { autoMapBankLedger } from "@/lib/finance/autoMap";

export const dynamic = "force-dynamic";

/** A stored rule with the label column only this screen needs — the reading path skips it. */
type StoredRule = GlRule & { counterparty_label: string | null };

/** A ledger row, reduced to what both summaries are built from. */
interface LedgerFacts {
  source: string;
  counterparty_key: string | null;
  counterparty_name: string | null;
  include_in_gl: boolean;
  transaction_date: string | null;
}

interface FeedSummary {
  source: string;
  transaction_count: number;
  earliest: string | null;
  latest: string | null;
  /** Whether these transactions reach the books right now. */
  included: boolean;
  /** True when that is a stored decision rather than the importer's default. */
  decided: boolean;
}

interface CounterpartySummary {
  source: string;
  counterparty_key: string;
  counterparty_label: string;
  transaction_count: number;
  included: boolean;
  decided: boolean;
}

export async function GET() {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }
  const supabase = createSupabaseAdminClient();

  // Deliberately unfiltered by include_in_gl: this screen is where a feed that
  // is NOT in the books gets looked at and decided about, so hiding excluded
  // rows here would hide the only thing the screen is for.
  const rows = await fetchAllRows<LedgerFacts>(() =>
    supabase
      .from("bank_ledger")
      .select("source, counterparty_key, counterparty_name, include_in_gl, transaction_date")
      .order("id", { ascending: true }),
  );

  const { data: ruleRows, error: ruleErr } = await supabase
    .from(BANK_LEDGER_GL_RULES_TABLE)
    .select("scope, source, counterparty_key, counterparty_label, included");
  if (ruleErr) return NextResponse.json({ error: ruleErr.message }, { status: 500 });
  const rules = (ruleRows ?? []) as StoredRule[];
  const stored = new Map(rules.map((r) => [ruleId(r), r]));
  const inclusion = buildInclusion(rules);

  const feeds = new Map<string, FeedSummary>();
  const parties = new Map<string, CounterpartySummary>();

  for (const row of rows) {
    const feed = feeds.get(row.source) ?? {
      source: row.source,
      transaction_count: 0,
      earliest: null,
      latest: null,
      // A feed's own state is the feed rule if there is one, otherwise what its
      // rows say. Rows within one feed agree in practice (an importer writes the
      // same flag for all of them), and where they would not, "any row counts"
      // is the honest summary of "these transactions reach the books".
      included: false,
      decided: false,
    };
    feed.transaction_count += 1;
    if (row.transaction_date) {
      if (!feed.earliest || row.transaction_date < feed.earliest) feed.earliest = row.transaction_date;
      if (!feed.latest   || row.transaction_date > feed.latest)   feed.latest   = row.transaction_date;
    }
    feed.included ||= row.include_in_gl;
    feeds.set(row.source, feed);

    const cpKey = counterpartyKeyOf(row);
    if (!cpKey) continue;
    const id = `${row.source} ${cpKey}`;
    const party = parties.get(id) ?? {
      source: row.source,
      counterparty_key: cpKey,
      counterparty_label: row.counterparty_name ?? cpKey,
      transaction_count: 0,
      included: true,
      decided: false,
    };
    party.transaction_count += 1;
    party.included = inclusion.allows(row);
    parties.set(id, party);
  }

  // A rule can name a feed or a counterparty with no transactions — either
  // because they have not synced yet, or because an earlier exclusion is exactly
  // why nothing is visible. Fold those in so a decision is never invisible.
  for (const rule of rules) {
    if (rule.scope === "source") {
      const feed = feeds.get(rule.source) ?? { source: rule.source, transaction_count: 0, earliest: null, latest: null, included: rule.included, decided: false };
      feed.included = rule.included;
      feeds.set(rule.source, feed);
    } else if (rule.counterparty_key) {
      const id = `${rule.source} ${rule.counterparty_key}`;
      const party = parties.get(id) ?? {
        source: rule.source,
        counterparty_key: rule.counterparty_key,
        counterparty_label: rule.counterparty_label ?? rule.counterparty_key,
        transaction_count: 0,
        included: rule.included,
        decided: false,
      };
      party.included = rule.included;
      parties.set(id, party);
    }
  }

  for (const feed of feeds.values()) feed.decided = stored.has(`source ${feed.source}`);
  for (const party of parties.values()) party.decided = stored.has(`counterparty ${party.source} ${party.counterparty_key}`);

  return NextResponse.json({
    feeds: [...feeds.values()].sort((a, b) => a.source.localeCompare(b.source)),
    counterparties: [...parties.values()].sort((a, b) => a.source.localeCompare(b.source) || a.counterparty_label.localeCompare(b.counterparty_label)),
  });
}

export async function PUT(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  const body = await req.json() as {
    scope?: string;
    source?: string;
    counterparty_key?: string | null;
    counterparty_label?: string | null;
    included?: boolean;
  };

  const scope = body.scope;
  const source = body.source?.trim();
  if (scope !== "source" && scope !== "counterparty") return NextResponse.json({ error: "scope must be source or counterparty" }, { status: 400 });
  if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
  const counterpartyKey = scope === "counterparty" ? body.counterparty_key?.trim() : null;
  if (scope === "counterparty" && !counterpartyKey) return NextResponse.json({ error: "counterparty_key required" }, { status: 400 });

  if (typeof body.included !== "boolean") return NextResponse.json({ error: "included must be true or false" }, { status: 400 });

  const supabase = createSupabaseAdminClient();

  // Not a plain .upsert(): both of this table's unique indexes are partial
  // (one per scope, see the table's migration), and PostgREST's upsert can
  // only emit `ON CONFLICT (columns)` with no WHERE, which Postgres refuses
  // to match against a partial index. upsert_bank_ledger_gl_rule spells out
  // the matching WHERE on each arm's own ON CONFLICT instead.
  const { data, error } = await supabase.rpc("upsert_bank_ledger_gl_rule", {
    p_scope: scope,
    p_source: source,
    p_counterparty_key: counterpartyKey ?? null,
    p_counterparty_label: body.counterparty_label ?? null,
    p_included: body.included,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Switching a feed on makes its transactions accounting facts, and an
  // accounting fact with no account is a gap somebody now has to close by hand.
  // Run the counterparty rules over it in the background so anything already
  // mapped for that feed lands coded, and only the genuinely unmapped remains.
  // autoMapBankLedger is fill-nulls-only and never touches a manual pin.
  if (scope === "source" && body.included === true) {
    after(async () => {
      const year = new Date().getFullYear();
      for (const y of [year, year - 1, year - 2]) {
        try {
          await autoMapBankLedger(supabase, { from: `${y}-01-01`, to: `${y}-12-31`, source });
        } catch (e) {
          console.error("[bank-ledger-rules] auto-map after opt-in failed", { source, year: y, error: e });
        }
      }
    });
  }

  return NextResponse.json(data);
}

function ruleId(rule: GlRule): string {
  return rule.scope === "source" ? `source ${rule.source}` : `counterparty ${rule.source} ${rule.counterparty_key}`;
}
