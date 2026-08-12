import { describe, it, expect } from "vitest";
import { rampTxnToExpenseRecord, rampBillToExpenseRecords, refreshBillSettlement, syncRampExpenses } from "./rampExpenses";
import type { RampTransaction, RampBill } from "@/lib/ramp";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

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
    sync_status: "SYNCED",
    qb_synced_at: "2026-06-16T02:00:00Z",
    gl_account: { id: "gl-1", external_id: "6000", name: "Meals & Entertainment" },
    card_holder: { first_name: "Sam", last_name: "Doe", department_name: "Ops", user_id: "u1" },
    ...over,
  };
}

function glSelection(name: string, code: string) {
  return { id: `opt-${code}`, name, external_id: "internal", external_code: code, category_info: { type: "GL_ACCOUNT" } };
}

function bill(over: Partial<RampBill> = {}): RampBill {
  return {
    id: "b1", amount: 130.44, currency_code: "USD", vendor_name: "RahrBSG",
    status: "PAID", issued_at: "2026-05-19T00:00:00Z", accounting_date: "2026-05-19T00:00:00Z",
    due_at: "2026-06-18T00:00:00Z", paid_at: "2026-07-08T16:20:00Z", memo: "malt", invoice_number: "INV-1",
    sync_status: "BILL_SYNCED", remote_id: "qb-bill-9",
    line_items: [
      { amount: 100.00, memo: "malt", accounting_field_selections: [glSelection("COGS:Raw Materials", "5110")] },
      { amount: 30.44,  memo: "freight", accounting_field_selections: [glSelection("COGS:Freight", "5120")] },
    ],
    ...over,
  };
}

describe("rampBillToExpenseRecords", () => {
  it("emits one outflow-negative record per line item with its own GL account", () => {
    const recs = rampBillToExpenseRecords(bill());
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({
      source: "ramp", ramp_object: "bill", source_transaction_id: "b1:0",
      amount_cents: -10000, merchant_name: "RahrBSG", state: "PAID",
      accounting_date: "2026-05-19", external_account_code: "5110",
      external_account_name: "COGS:Raw Materials", memo: "malt",
    });
    expect(recs[1]).toMatchObject({ source_transaction_id: "b1:1", amount_cents: -3044, external_account_code: "5120" });
    expect(recs[0].card_holder_name).toBeNull();
    expect(recs[0].department_name).toBeNull();
    // Every line item inherits the bill's QB sync state + remote id; synced_at is bill-null.
    expect(recs[0]).toMatchObject({ qb_sync_status: "BILL_SYNCED", qb_remote_id: "qb-bill-9", qb_synced_at: null });
    expect(recs[1]).toMatchObject({ qb_sync_status: "BILL_SYNCED", qb_remote_id: "qb-bill-9" });
  });

  // expenses.state is upper-case-only (CHECK expenses_state_upper_check) so the
  // statements can match it exactly. Ramp's status is passed straight through by
  // lib/ramp.ts with no allow-list, so the fold has to happen on write.
  it("upper-cases the bill status and nulls Ramp's empty-string sentinel", () => {
    expect(rampBillToExpenseRecords(bill({ status: "paid" }))[0].state).toBe("PAID");
    expect(rampBillToExpenseRecords(bill({ status: "Partially_Paid" }))[0].state).toBe("PARTIALLY_PAID");
    expect(rampBillToExpenseRecords(bill({ status: "" }))[0].state).toBeNull();
  });

  it("falls back to a single uncoded record when a bill has no line items", () => {
    const recs = rampBillToExpenseRecords(bill({ line_items: [] }));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ source_transaction_id: "b1:0", amount_cents: -13044, external_account_id: null });
  });
});

/**
 * `settled_at` is what makes accounts payable answerable for a past month --
 * `state` cannot, being overwritten in place on every sync. See
 * balances/providers/openBillAp.ts.
 */
describe("bill settlement", () => {
  it("records when a paid bill was settled, on every one of its lines", () => {
    const recs = rampBillToExpenseRecords(bill({ paid_at: "2026-07-08T16:20:00Z" }));

    expect(recs.map((r) => r.settled_at)).toEqual(["2026-07-08T16:20:00Z", "2026-07-08T16:20:00Z"]);
  });

  it("leaves it null while the bill is still owed", () => {
    const recs = rampBillToExpenseRecords(bill({ status: "OPEN", paid_at: null }));

    expect(recs[0].settled_at).toBeNull();
    expect(recs[0].state).toBe("OPEN");
  });

  /**
   * Written explicitly rather than omitted, so the upsert carries the change.
   * Ramp's absent-value sentinel is "", and leaving a stale timestamp behind
   * would strand a re-opened bill outside the payables it belongs to.
   */
  it("clears a stale settlement rather than omitting the field", () => {
    const recs = rampBillToExpenseRecords(bill({ paid_at: "" }));

    expect(recs[0]).toHaveProperty("settled_at", null);
  });

  it("does not claim a card swipe was settled later — there is no gap to record", () => {
    expect(rampTxnToExpenseRecord(txn()).settled_at).toBeUndefined();
  });
});

describe("refreshBillSettlement", () => {
  function fakeClient() {
    const updates: { patch: Record<string, unknown>; eq: [string, unknown][]; like: [string, string][] }[] = [];
    const chain: Record<string, unknown> = {
      update: (patch: Record<string, unknown>) => {
        updates.push({ patch, eq: [], like: [] });
        return chain;
      },
      eq: (col: string, val: unknown) => { updates[updates.length - 1].eq.push([col, val]); return chain; },
      like: (col: string, val: string) => { updates[updates.length - 1].like.push([col, val]); return chain; },
      then: (resolve: (v: unknown) => unknown) => resolve({ error: null, count: 2 }),
    };
    const supabase = { from: () => chain } as unknown as ReturnType<typeof createSupabaseAdminClient>;
    return { supabase, updates };
  }

  /**
   * The whole reason this function exists. A bill incurred in June and paid in
   * August is outside the daily cron's 45-day window at payment time, so without
   * a settlement refresh it keeps June's OPEN state forever and accounts payable
   * only ever grows -- the failure GL 2310 shipped with.
   */
  it("writes each bill's current state and settlement date", async () => {
    const { supabase, updates } = fakeClient();

    await refreshBillSettlement(supabase, [
      bill({ id: "b1", status: "PAID", paid_at: "2026-08-07T10:00:00Z" }),
      bill({ id: "b2", status: "OPEN", paid_at: null }),
    ]);

    expect(updates.map((u) => u.patch)).toEqual([
      { state: "PAID", settled_at: "2026-08-07T10:00:00Z" },
      { state: "OPEN", settled_at: null },
    ]);
  });

  /**
   * Scoped to the bill's own lines, and to bills. The colon is load-bearing:
   * without it one bill id could prefix-match another's and settle a debt that
   * is still owed.
   */
  it("touches only the line items of the bill it is updating", async () => {
    const { supabase, updates } = fakeClient();

    await refreshBillSettlement(supabase, [bill({ id: "b1" })]);

    expect(updates[0].like).toEqual([["source_transaction_id", "b1:%"]]);
    expect(updates[0].eq).toEqual([["source", "ramp"], ["ramp_object", "bill"]]);
  });

  it("reports how many stored rows it touched", async () => {
    const { supabase } = fakeClient();

    const result = await refreshBillSettlement(supabase, [bill({ id: "b1" }), bill({ id: "b2" })]);

    expect(result).toEqual({ refreshed: 4 });
  });
});

describe("rampTxnToExpenseRecord", () => {
  it("shapes a clean source='ramp' record with external-account fields and cents", () => {
    const r = rampTxnToExpenseRecord(txn());
    expect(r).toMatchObject({
      source: "ramp",
      ramp_object: "card",
      source_transaction_id: "t1",
      amount_cents: -1234,
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
      qb_sync_status: "SYNCED",
      qb_synced_at: "2026-06-16T02:00:00Z",
      qb_remote_id: null,
    });
  });

  // See the bill-status test above: the column enforces upper-case, so the
  // adapter must normalize rather than trust Ramp's casing.
  it("upper-cases the transaction state and nulls Ramp's empty-string sentinel", () => {
    expect(rampTxnToExpenseRecord(txn({ state: "cleared" })).state).toBe("CLEARED");
    expect(rampTxnToExpenseRecord(txn({ state: "Declined" })).state).toBe("DECLINED");
    expect(rampTxnToExpenseRecord(txn({ state: "" })).state).toBeNull();
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
    expect(r.ramp_object).toBe("card");
  });
});

// ── syncRampExpenses ─────────────────────────────────────────────────────────
type Row = Record<string, unknown>;

/**
 * Minimal fake of the Supabase query surface used by syncRampExpenses.
 * select() returns a chainable/thenable builder supporting .eq()/.in();
 * upsert() captures the written rows.
 */
function makeClient(cfg: { coa: Row[]; rules: Row[]; existing: Row[]; existingSelectError?: string }) {
  const captured = { ruleUpserts: [] as Row[], expenseUpserts: [] as Row[], ruleUpdates: [] as Row[] };

  function query(baseData: Row[], errorMessage?: string) {
    const filters: ((r: Row) => boolean)[] = [];
    const q = {
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return q; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return q; },
      then(res: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) {
        if (errorMessage) return Promise.resolve({ data: null, error: { message: errorMessage } }).then(res);
        const data = baseData.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data, error: null }).then(res);
      },
    };
    return q;
  }

  const client = {
    from(table: string) {
      const baseData =
        table === "chart_of_accounts"             ? cfg.coa :
        table === "expense_account_mappings"      ? cfg.rules :
        table === "expense_counterparty_mappings" ? [] :
        table === "expenses"                      ? cfg.existing : [];
      return {
        select() { return query(baseData, table === "expenses" ? cfg.existingSelectError : undefined); },
        upsert(rows: Row[]) {
          if (table === "expense_account_mappings") captured.ruleUpserts.push(...rows);
          if (table === "expenses")                 captured.expenseUpserts.push(...rows);
          return Promise.resolve({ error: null });
        },
        update(patch: Row) {
          const applied: Row = { ...patch };
          const u = {
            eq(col: string, val: unknown) { applied[col] = val; return u; },
            then(res: (v: { error: null }) => unknown) {
              if (table === "expense_account_mappings") captured.ruleUpdates.push(applied);
              return Promise.resolve({ error: null }).then(res);
            },
          };
          return u;
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

  // The account's name/code are properties of the ACCOUNT, so they live on
  // expense_account_mappings and are never copied onto an expense row. Writing
  // them here is what let the two copies drift apart in the first place.
  it("does not persist the account name or code onto the expense row", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [],
      existing: [],
    });

    await syncRampExpenses(client, [glTxn("t1", { id: "gl-1", external_id: "6000", name: "Marketing" })]);

    expect(captured.expenseUpserts[0]).not.toHaveProperty("external_account_name");
    expect(captured.expenseUpserts[0]).not.toHaveProperty("external_account_code");
    // The id stays -- it is the key the read-side join derives the name through.
    expect(captured.expenseUpserts[0]).toMatchObject({ external_account_id: "gl-1" });
    // ...and the account row carrying that name is written before the expense.
    expect(captured.ruleUpserts[0]).toMatchObject({ external_account_id: "gl-1", external_account_name: "Marketing", external_account_code: "6000" });
  });

  it("refreshes the mapping's name when the source renames the account", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [{ source: "ramp", external_account_id: "gl-1", external_account_name: "Marketing", chart_of_accounts_id: "coa-1" }],
      existing: [],
    });

    await syncRampExpenses(client, [glTxn("t1", { id: "gl-1", external_id: "6000", name: "Advertising & Marketing" })]);

    expect(captured.ruleUpdates).toEqual([
      { external_account_name: "Advertising & Marketing", source: "ramp", external_account_id: "gl-1" },
    ]);
  });

  it("leaves the mapping alone when the name is unchanged", async () => {
    const { client, captured } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [{ source: "ramp", external_account_id: "gl-1", external_account_name: "Marketing", chart_of_accounts_id: "coa-1" }],
      existing: [],
    });

    await syncRampExpenses(client, [glTxn("t1", { id: "gl-1", external_id: "6000", name: "Marketing" })]);

    expect(captured.ruleUpdates).toEqual([]);
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

  it("throws (never silently drops manual pins) when the existing-expenses lookup errors", async () => {
    const { client } = makeClient({
      coa: [{ id: "coa-1", account_name: "Marketing", account_number: "6000" }],
      rules: [{ source: "ramp", external_account_id: "gl-1", chart_of_accounts_id: "coa-1" }],
      existing: [{ source: "ramp", source_transaction_id: "t1", mapping_source: "manual", chart_of_accounts_id: "coa-manual" }],
      existingSelectError: "connection reset",
    });

    await expect(syncRampExpenses(client, [glTxn("t1", { id: "gl-1", external_id: "6000", name: "Marketing" })]))
      .rejects.toThrow(/Load existing expenses failed: connection reset/);
  });

  it("leaves untagged expenses unmapped", async () => {
    const { client, captured } = makeClient({ coa: [], rules: [], existing: [] });
    const res = await syncRampExpenses(client, [glTxn("t1", null)]);
    expect(res).toMatchObject({ mapped: 0, unmapped: 1, new_rules: 0 });
    expect(captured.expenseUpserts[0]).toMatchObject({ mapping_source: "unmapped" });
  });
});
