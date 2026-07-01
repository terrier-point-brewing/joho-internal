import { describe, it, expect } from "vitest";
import { syncRampExpenses } from "./rampExpenseSync";
import type { RampTransaction } from "@/lib/ramp";

type Row = Record<string, unknown>;

/**
 * Minimal fake of the Supabase query surface used by syncRampExpenses:
 *   from(t).select(cols)            → awaited directly (coa, rules)
 *   from(t).select(cols).in(c, ids) → awaited (existing expenses)
 *   from(t).upsert(rows, opts)      → awaited; rows captured
 */
function makeClient(cfg: { coa: Row[]; rules: Row[]; existing: Row[] }) {
  const captured = { ruleUpserts: [] as Row[], expenseUpserts: [] as Row[] };

  const client = {
    from(table: string) {
      return {
        select() {
          const baseData =
            table === "chart_of_accounts"          ? cfg.coa :
            table === "ramp_gl_account_mappings"   ? cfg.rules :
            table === "ramp_expenses"              ? cfg.existing : [];
          return {
            in(_col: string, ids: string[]) {
              const data = cfg.existing.filter((e) => ids.includes(e.ramp_transaction_id as string));
              return Promise.resolve({ data, error: null });
            },
            then(res: (v: { data: Row[]; error: null }) => unknown) {
              return Promise.resolve({ data: baseData, error: null }).then(res);
            },
          };
        },
        upsert(rows: Row[]) {
          if (table === "ramp_gl_account_mappings") captured.ruleUpserts.push(...rows);
          if (table === "ramp_expenses")            captured.expenseUpserts.push(...rows);
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, captured };
}

function txn(id: string, gl: RampTransaction["gl_account"], amount = 10): RampTransaction {
  return {
    id,
    amount,
    currency_code: "USD",
    memo: "",
    merchant_name: "M",
    merchant_category_code_description: "Cat",
    sk_category_name: null,
    state: "CLEARED",
    user_transaction_time: "2026-06-01T00:00:00Z",
    accounting_date: "2026-06-01T00:00:00Z",
    gl_account: gl,
    card_holder: { first_name: "A", last_name: "B", department_name: "Ops", user_id: "u" },
  };
}

describe("syncRampExpenses", () => {
  it("auto-matches a new GL account to the chart of accounts and maps its expense", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [],
      existing: [],
    });

    const res = await syncRampExpenses(client, [
      txn("t1", { id: "gl-1", external_id: "6000", name: "Marketing" }),
    ]);

    expect(res).toMatchObject({ imported: 1, mapped: 1, unmapped: 0, new_rules: 1, auto_matched_rules: 1 });
    expect(captured.ruleUpserts[0]).toMatchObject({ ramp_gl_id: "gl-1", chart_of_accounts_id: "coa-1", auto_matched: true });
    expect(captured.expenseUpserts[0]).toMatchObject({ ramp_transaction_id: "t1", chart_of_accounts_id: "coa-1", mapping_source: "rule" });
  });

  it("creates an unmapped rule when the GL account has no CoA match", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [],
      existing: [],
    });

    const res = await syncRampExpenses(client, [
      txn("t1", { id: "gl-9", external_id: "9999", name: "Mystery" }),
    ]);

    expect(res).toMatchObject({ mapped: 0, unmapped: 1, new_rules: 1, auto_matched_rules: 0 });
    expect(captured.ruleUpserts[0]).toMatchObject({ ramp_gl_id: "gl-9", chart_of_accounts_id: null });
    expect(captured.expenseUpserts[0]).toMatchObject({ mapping_source: "unmapped", chart_of_accounts_id: null });
  });

  it("follows an existing rule and does not recreate it", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [{ ramp_gl_id: "gl-1", chart_of_accounts_id: "coa-1" }],
      existing: [],
    });

    const res = await syncRampExpenses(client, [txn("t1", { id: "gl-1", external_id: "6000", name: "Marketing" })]);

    expect(res.new_rules).toBe(0);
    expect(res.mapped).toBe(1);
    expect(captured.expenseUpserts[0]).toMatchObject({ chart_of_accounts_id: "coa-1", mapping_source: "rule" });
  });

  it("preserves a manual per-expense override across re-sync", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [{ ramp_gl_id: "gl-1", chart_of_accounts_id: "coa-1" }],
      existing: [{ ramp_transaction_id: "t1", mapping_source: "manual", chart_of_accounts_id: "coa-manual" }],
    });

    await syncRampExpenses(client, [txn("t1", { id: "gl-1", external_id: "6000", name: "Marketing" })]);

    expect(captured.expenseUpserts[0]).toMatchObject({ chart_of_accounts_id: "coa-manual", mapping_source: "manual" });
  });

  it("leaves untagged expenses unmapped", async () => {
    const { client, captured } = makeClient({ coa: [], rules: [], existing: [] });
    const res = await syncRampExpenses(client, [txn("t1", null)]);
    expect(res).toMatchObject({ mapped: 0, unmapped: 1, new_rules: 0 });
    expect(captured.expenseUpserts[0]).toMatchObject({ mapping_source: "unmapped" });
  });
});
