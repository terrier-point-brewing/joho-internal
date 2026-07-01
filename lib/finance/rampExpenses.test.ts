import { describe, it, expect } from "vitest";
import { rampTxnToExpenseRecord, syncRampExpenses } from "./rampExpenses";
import type { RampTransaction } from "@/lib/ramp";

function txn(over: Partial<RampTransaction> = {}): RampTransaction {
  return {
    id: "t1",
    amount: 12.34,
    currency_code: "USD",
    memo: "lunch",
    merchant_name: "Cafe",
    merchant_category_code_description: "Restaurants",
    sk_category_name: "Meals",
    state: "CLEARED",
    user_transaction_time: "2026-06-15T14:00:00Z",
    accounting_date: "2026-06-15T00:00:00Z",
    gl_account: { id: "gl-1", external_id: "6000", name: "Meals & Entertainment" },
    card_holder: { first_name: "Sam", last_name: "Doe", department_name: "Ops", user_id: "u1" },
    ...over,
  };
}

describe("rampTxnToExpenseRecord", () => {
  it("shapes a clean source='ramp' record with external-account fields and cents", () => {
    const r = rampTxnToExpenseRecord(txn());
    expect(r).toMatchObject({
      source: "ramp",
      source_transaction_id: "t1",
      amount_cents: 1234,
      currency_code: "USD",
      memo: "lunch",
      merchant_name: "Cafe",
      merchant_category: "Restaurants",
      card_holder_name: "Sam Doe",
      department_name: "Ops",
      accounting_date: "2026-06-15",
      external_account_id: "gl-1",
      external_account_name: "Meals & Entertainment",
      external_account_code: "6000",
    });
  });

  it("nulls empty strings and a missing GL account", () => {
    const r = rampTxnToExpenseRecord(txn({
      memo: "",
      merchant_name: "",
      sk_category_name: null,
      accounting_date: "",
      gl_account: null,
      card_holder: { first_name: "", last_name: "", department_name: "", user_id: "u" },
    }));
    expect(r.memo).toBeNull();
    expect(r.merchant_name).toBeNull();
    expect(r.accounting_date).toBeNull();
    expect(r.card_holder_name).toBeNull();
    expect(r.department_name).toBeNull();
    expect(r.external_account_id).toBeNull();
    expect(r.source).toBe("ramp");
  });
});

// ── syncRampExpenses ─────────────────────────────────────────────────────────
type Row = Record<string, unknown>;

/**
 * Minimal fake of the Supabase query surface used by syncRampExpenses.
 * select() returns a chainable/thenable builder supporting .eq()/.in();
 * upsert() captures the written rows.
 */
function makeClient(cfg: { coa: Row[]; rules: Row[]; existing: Row[] }) {
  const captured = { ruleUpserts: [] as Row[], expenseUpserts: [] as Row[] };

  function query(baseData: Row[]) {
    const filters: ((r: Row) => boolean)[] = [];
    const q = {
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return q; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return q; },
      then(res: (v: { data: Row[]; error: null }) => unknown) {
        const data = baseData.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data, error: null }).then(res);
      },
    };
    return q;
  }

  const client = {
    from(table: string) {
      const baseData =
        table === "chart_of_accounts"        ? cfg.coa :
        table === "expense_account_mappings" ? cfg.rules :
        table === "expenses"                 ? cfg.existing : [];
      return {
        select() { return query(baseData); },
        upsert(rows: Row[]) {
          if (table === "expense_account_mappings") captured.ruleUpserts.push(...rows);
          if (table === "expenses")                 captured.expenseUpserts.push(...rows);
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, captured };
}

function glTxn(id: string, gl: RampTransaction["gl_account"]): RampTransaction {
  return txn({ id, gl_account: gl });
}

describe("syncRampExpenses", () => {
  it("auto-matches a new external account to the chart of accounts and maps its expense", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [],
      existing: [],
    });

    const res = await syncRampExpenses(client, [glTxn("t1", { id: "gl-1", external_id: "6000", name: "Marketing" })]);

    expect(res).toMatchObject({ imported: 1, mapped: 1, unmapped: 0, new_rules: 1, auto_matched_rules: 1 });
    expect(captured.ruleUpserts[0]).toMatchObject({ source: "ramp", external_account_id: "gl-1", chart_of_accounts_id: "coa-1", auto_matched: true });
    expect(captured.expenseUpserts[0]).toMatchObject({ source: "ramp", source_transaction_id: "t1", chart_of_accounts_id: "coa-1", mapping_source: "rule" });
  });

  it("creates an unmapped rule when the external account has no CoA match", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [],
      existing: [],
    });

    const res = await syncRampExpenses(client, [glTxn("t1", { id: "gl-9", external_id: "9999", name: "Mystery" })]);

    expect(res).toMatchObject({ mapped: 0, unmapped: 1, new_rules: 1, auto_matched_rules: 0 });
    expect(captured.ruleUpserts[0]).toMatchObject({ external_account_id: "gl-9", chart_of_accounts_id: null });
    expect(captured.expenseUpserts[0]).toMatchObject({ mapping_source: "unmapped", chart_of_accounts_id: null });
  });

  it("follows an existing rule and does not recreate it", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [{ source: "ramp", external_account_id: "gl-1", chart_of_accounts_id: "coa-1" }],
      existing: [],
    });

    const res = await syncRampExpenses(client, [glTxn("t1", { id: "gl-1", external_id: "6000", name: "Marketing" })]);

    expect(res.new_rules).toBe(0);
    expect(res.mapped).toBe(1);
    expect(captured.expenseUpserts[0]).toMatchObject({ chart_of_accounts_id: "coa-1", mapping_source: "rule" });
  });

  it("preserves a manual per-expense override across re-sync", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [{ source: "ramp", external_account_id: "gl-1", chart_of_accounts_id: "coa-1" }],
      existing: [{ source: "ramp", source_transaction_id: "t1", mapping_source: "manual", chart_of_accounts_id: "coa-manual" }],
    });

    await syncRampExpenses(client, [glTxn("t1", { id: "gl-1", external_id: "6000", name: "Marketing" })]);

    expect(captured.expenseUpserts[0]).toMatchObject({ chart_of_accounts_id: "coa-manual", mapping_source: "manual" });
  });

  it("leaves untagged expenses unmapped", async () => {
    const { client, captured } = makeClient({ coa: [], rules: [], existing: [] });
    const res = await syncRampExpenses(client, [glTxn("t1", null)]);
    expect(res).toMatchObject({ mapped: 0, unmapped: 1, new_rules: 0 });
    expect(captured.expenseUpserts[0]).toMatchObject({ mapping_source: "unmapped" });
  });
});
