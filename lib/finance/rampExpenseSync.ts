/**
 * Orchestrates a Ramp expense sync: turns fetched Ramp transactions into clean
 * ramp_expenses rows, ensures a GL→CoA rule exists for every GL account seen
 * (auto-matching against the chart of accounts), and resolves each expense's
 * account from those rules — while never disturbing manual per-expense pins.
 *
 * IO lives here; the mapping decisions come from the pure helpers in
 * ./rampExpenses (unit-tested separately).
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { RampTransaction } from "@/lib/ramp";
import {
  rampTxnToExpenseRecord,
  matchGlToCoa,
  resolveExpenseMapping,
  type CoaAccountRef,
  type RuleRef,
  type MappingSource,
} from "./rampExpenses";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface RampSyncResult {
  imported:           number;
  mapped:             number;
  unmapped:           number;
  new_rules:          number;
  auto_matched_rules: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function syncRampExpenses(
  supabase: AdminClient,
  txns: RampTransaction[],
): Promise<RampSyncResult> {
  const records = txns.map(rampTxnToExpenseRecord);

  // Chart of accounts — for auto-matching new GL accounts.
  const { data: accountRows, error: coaErr } = await supabase
    .from("chart_of_accounts")
    .select("id, account_name, account_number");
  if (coaErr) throw new Error(`Load chart of accounts failed: ${coaErr.message}`);
  const coa = (accountRows ?? []) as CoaAccountRef[];

  // Existing GL→CoA rules.
  const { data: ruleRows, error: ruleErr } = await supabase
    .from("ramp_gl_account_mappings")
    .select("ramp_gl_id, chart_of_accounts_id");
  if (ruleErr) throw new Error(`Load GL mappings failed: ${ruleErr.message}`);

  const ruleByGlId = new Map<string, RuleRef>();
  for (const r of ruleRows ?? []) {
    ruleByGlId.set(r.ramp_gl_id, { ramp_gl_id: r.ramp_gl_id, chart_of_accounts_id: r.chart_of_accounts_id });
  }

  // Create a rule for every GL account in this batch we haven't seen before,
  // auto-matching it to the chart of accounts where we can.
  const distinctGl = new Map<string, { name: string; code: string | null }>();
  for (const rec of records) {
    if (rec.ramp_gl_id && !distinctGl.has(rec.ramp_gl_id)) {
      distinctGl.set(rec.ramp_gl_id, { name: rec.ramp_gl_name ?? "", code: rec.ramp_gl_code });
    }
  }

  const newRules: {
    ramp_gl_id: string;
    ramp_gl_name: string;
    ramp_gl_code: string | null;
    chart_of_accounts_id: string | null;
    auto_matched: boolean;
  }[] = [];
  let autoMatched = 0;

  for (const [glId, gl] of distinctGl) {
    if (ruleByGlId.has(glId)) continue;
    const coaId = matchGlToCoa({ name: gl.name, external_id: gl.code }, coa);
    if (coaId) autoMatched++;
    newRules.push({
      ramp_gl_id:           glId,
      ramp_gl_name:         gl.name,
      ramp_gl_code:         gl.code,
      chart_of_accounts_id: coaId,
      auto_matched:         true,
    });
    ruleByGlId.set(glId, { ramp_gl_id: glId, chart_of_accounts_id: coaId });
  }

  if (newRules.length > 0) {
    const { error } = await supabase
      .from("ramp_gl_account_mappings")
      .upsert(newRules, { onConflict: "ramp_gl_id" });
    if (error) throw new Error(`Insert GL mappings failed: ${error.message}`);
  }

  // Preserve manual per-expense overrides across re-syncs.
  const existing = new Map<string, { mapping_source: MappingSource; chart_of_accounts_id: string | null }>();
  for (const ids of chunk(records.map((r) => r.ramp_transaction_id), 500)) {
    const { data } = await supabase
      .from("ramp_expenses")
      .select("ramp_transaction_id, mapping_source, chart_of_accounts_id")
      .in("ramp_transaction_id", ids);
    for (const e of data ?? []) {
      existing.set(e.ramp_transaction_id, { mapping_source: e.mapping_source, chart_of_accounts_id: e.chart_of_accounts_id });
    }
  }

  const syncedAt = new Date().toISOString();
  let mapped = 0;
  let unmapped = 0;

  const upsertRows = records.map((rec) => {
    const prior = existing.get(rec.ramp_transaction_id);
    const resolved = resolveExpenseMapping(
      {
        ramp_gl_id:           rec.ramp_gl_id,
        mapping_source:       prior?.mapping_source ?? "unmapped",
        chart_of_accounts_id: prior?.chart_of_accounts_id ?? null,
      },
      ruleByGlId,
    );
    if (resolved.chart_of_accounts_id) mapped++;
    else unmapped++;
    return {
      ...rec,
      chart_of_accounts_id: resolved.chart_of_accounts_id,
      mapping_source:       resolved.mapping_source,
      synced_at:            syncedAt,
    };
  });

  for (const rows of chunk(upsertRows, 500)) {
    const { error } = await supabase
      .from("ramp_expenses")
      .upsert(rows, { onConflict: "ramp_transaction_id" });
    if (error) throw new Error(`Upsert ramp expenses failed: ${error.message}`);
  }

  return {
    imported:           records.length,
    mapped,
    unmapped,
    new_rules:          newRules.length,
    auto_matched_rules: autoMatched,
  };
}
