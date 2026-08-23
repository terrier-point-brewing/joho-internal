/**
 * One question, asked of every job: if somebody runs this again, does the work
 * a person did by hand survive?
 *
 * The question is new. Until now these jobs ran once a night on a narrow recent
 * window, at an hour when nobody was correcting anything. A button that starts
 * one at any moment points them at data a person has since coded, split,
 * excluded or reconciled — so "is it idempotent" is no longer the whole test.
 * A sync can be perfectly idempotent and still be destructive, by converging on
 * the source's answer instead of the operator's.
 *
 * There is prior art proving the failure is real rather than theoretical: the
 * migration 20260911090000_pos_line_items_gl_manually_set.sql exists because a
 * re-sync was overwriting hand-assigned accounts on order lines.
 *
 * The per-module tests already cover the mechanics. What this file adds is the
 * cross-job answer in one place, so that changing any job's answer has to come
 * with changing this file.
 *
 * It has already earned that. The invoice-line block below was written to pin
 * an answer of NO — finance-sync and finance-gap-scan rebuilt an invoice's
 * lines from the catalogue with no read-before-write at all — and inverting it
 * is what closed that finding.
 */
import { describe, it, expect, vi } from "vitest";

// The invoice half of syncSquareOrders builds its line-item indexes from the
// Square catalog. None of these tests turn on a real catalog item.
vi.mock("@/lib/square/catalog", () => ({ fetchCatalogItems: async () => [] }));

import { buildPosLineItems, syncSquareOrders } from "@/lib/finance/syncPosTransactions";
import { financeSyncDb } from "@/lib/finance/__fixtures__/financeSyncDb";
import { resolveExpenseMapping, type RuleRef, type CounterpartyRuleRef } from "@/lib/finance/expenses";
import { pruneReclassifiedBankExpenses } from "@/lib/finance/rampSync";
import { preserveOperatorCoding } from "@/lib/finance/balances/plaidTransactionSync";
import { remainingDelta } from "@/lib/production/taproomConsumptionSync";
import { resolveSnapshotWrites } from "@/lib/finance/balances/snapshot";
import { ensureTasksForSchedule } from "@/lib/tax/tasks";
import { registerParty } from "@/lib/tax/registry";
import { periodContaining, lastDayOfFollowingMonth } from "@/lib/tax/period";
import type { TaxPartyTemplate, TaxSchedule } from "@/lib/tax/types";
import { runPayrollAdvance } from "@/lib/cron/jobs/payrollAdvance";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Runs one job's write path against a client that answers every read with a
 * single plausible row, and reports the options its upsert was given.
 *
 * The property under test is `ignoreDuplicates`, which is what makes these three
 * jobs leave an existing row alone. It is one word, it is invisible at the call
 * site, and dropping it turns each of them into a job that overwrites a person's
 * work on every run — so it is worth a test of its own.
 */
async function captureUpsertOptions(
  run: (client: SupabaseClient) => Promise<unknown>,
  /** Tables that must answer with nothing, so the job finds work left to do. */
  emptyTables: string[] = [],
): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;
  // One row broad enough to satisfy every read these three jobs make; each of
  // them ignores the columns it does not recognise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = {
    id: "row-1", chart_of_accounts_id: "coa-1",
    start_date: "2026-06-01", end_date: "2026-06-14",
    pay_period_frequency: "biweekly", due_date_days_after_end: 3,
    method_key: "manualBalance", due_days_after_month_end: null, is_active: true,
    responsible_user_id: null, close_due_day: 15,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = (table: string): any => {
    const rows = emptyTables.includes(table) ? [] : [row];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit", "gte", "lte", "neq"]) b[m] = () => b;
    b.single = async () => ({ data: rows[0] ?? null, error: null });
    b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    b.upsert = (_payload: unknown, opts: Record<string, unknown>) => {
      captured = opts;
      return b;
    };
    b.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve);
    return b;
  };
  await run({ from: builder } as unknown as SupabaseClient);
  return captured;
}

/** A tax party with no dependency on a real filing template. */
const stubTaxParty: TaxPartyTemplate = {
  key: "rerun-stub-party",
  label: "Stub Party",
  supportedFrequencies: ["monthly", "quarterly", "annual"],
  computePeriod: (freq, ref) => {
    const { start, end } = periodContaining(freq, ref);
    return { start, end, due: lastDayOfFollowingMonth(end) };
  },
  defaultDueRule: () => ({ monthOffset: 1, day: 20 }),
  computeWorksheet: async () => ({ fields: {} }),
  fieldOwnership: {},
  mergeWorksheet: (current) => current,
  settingsSchema: [],
  scheduleConfigSchema: [],
  requiredRegistrations: [],
  buildReferenceView: () => ({ tables: [] }),
  worksheetComponent: "Stub",
};

function stubSchedule(): TaxSchedule {
  return {
    id: "sched-1",
    filing_key: stubTaxParty.key,
    frequency: "monthly",
    lead_days: 7,
    active: true,
    config: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** One Square line, invoice-backed or not depending on who reads it. */
function squareOrder() {
  return {
    line_items: [
      {
        uid: "line-1",
        catalog_object_id: "var-hazy",
        name: "Hazy IPA",
        quantity: "2",
        base_price_money: { amount: 800 },
        gross_sales_money: { amount: 1600 },
        total_discount_money: { amount: 0 },
        total_tax_money: { amount: 0 },
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** The same order as syncSquareOrders receives it: identified and completed. */
function invoiceOrder() {
  return {
    ...squareOrder(),
    id: "order-1",
    location_id: "loc-1",
    state: "COMPLETED",
    created_at: "2026-07-23T10:00:00Z",
  };
}

/** The catalogue's answer, which is what a re-sync reaches for by default. */
const catalogSaysTaproom = () => "coa-taproom-sales";

describe("finance-sync and finance-gap-scan: an order line", () => {
  it("keeps an account somebody set by hand, instead of reverting to the catalogue", () => {
    const prior = new Map([
      ["line-1", { chart_of_accounts_id: "coa-chosen-by-hand", gl_manually_set: true, notes: null }],
    ]);

    const [row] = buildPosLineItems("order-1", squareOrder(), catalogSaysTaproom, prior);

    expect(row.chart_of_accounts_id).toBe("coa-chosen-by-hand");
  });

  it("keeps the mark saying a person chose it, not a rule", () => {
    // Preserving the account while dropping the mark would silently reclassify
    // a person's decision as rule-derived, which is exactly what the Orders grid
    // uses to show an override.
    const prior = new Map([
      ["line-1", { chart_of_accounts_id: "coa-chosen-by-hand", gl_manually_set: true, notes: null }],
    ]);

    const [row] = buildPosLineItems("order-1", squareOrder(), catalogSaysTaproom, prior);

    expect(row.gl_manually_set).toBe(true);
  });

  it("keeps a note left on the line", () => {
    const prior = new Map([
      ["line-1", { chart_of_accounts_id: null, gl_manually_set: false, notes: "billed to the wedding deposit" }],
    ]);

    const [row] = buildPosLineItems("order-1", squareOrder(), catalogSaysTaproom, prior);

    expect(row.notes).toBe("billed to the wedding deposit");
  });

  it("still applies the catalogue to a line nobody has touched", () => {
    const [row] = buildPosLineItems("order-1", squareOrder(), catalogSaysTaproom, new Map());

    expect(row.chart_of_accounts_id).toBe("coa-taproom-sales");
    expect(row.gl_manually_set).toBe(false);
  });
});

describe("finance-sync and finance-gap-scan: an INVOICE line", () => {
  /**
   * This block used to pin the opposite answer. Re-syncing an order raised from
   * an invoice rebuilt that invoice's lines from the catalogue with no
   * read-before-write at all, so a hand-set account was replaced — and on a
   * product the catalogue does not map, replaced with nothing.
   *
   * The fix was not to add a prior-state argument to the builder that did it.
   * That builder numbered lines from one while the canonical writer numbers
   * from zero and drops carve-out excise lines, so the two disagreed about
   * which row is which and any preservation keyed on a line number would have
   * matched the wrong row. There is now a single writer: syncSquareOrders calls
   * buildInvoiceLineItemRows + persistInvoiceLineItems, the same pair the
   * invoice sync and the export routes use.
   *
   * These run the real sync against a stub that remembers, because that is
   * where the damage was — in the relationship between a builder and a writer,
   * not inside either one.
   */
  const seed = {
    invoices: [{ id: "invoice-1", raw_data: { square_order_id: "order-1" } }],
    square_catalog_variations: [{
      square_variation_id: "var-hazy",
      chart_of_accounts_id: "coa-taproom-sales",
      chart_of_accounts_id_pos: null,
      chart_of_accounts_id_invoice: null,
    }],
  };

  /** One stored line, as a previous sync left it. */
  const handCoded = (coa: string | null) => [{
    invoice_id: "invoice-1", sort_order: 0, description: "Hazy IPA",
    square_line_item_uid: "line-1", chart_of_accounts_id: coa,
  }];

  it("keeps an account somebody set by hand, instead of reverting to the catalogue", async () => {
    const db = financeSyncDb({ ...seed, invoice_line_items: handCoded("coa-chosen-by-hand") });

    await syncSquareOrders(db.client, [invoiceOrder()]);

    expect(db.rows("invoice_line_items").map((r) => r.chart_of_accounts_id)).toEqual(["coa-chosen-by-hand"]);
  });

  it("keeps it even on a product the catalogue does not map", async () => {
    // The damaging case: this line used to come back empty rather than merely
    // reclassified, so the coding was gone rather than wrong.
    const db = financeSyncDb({
      invoices: seed.invoices,
      square_catalog_variations: [],
      invoice_line_items: handCoded("coa-chosen-by-hand"),
    });

    await syncSquareOrders(db.client, [invoiceOrder()]);

    expect(db.rows("invoice_line_items").map((r) => r.chart_of_accounts_id)).toEqual(["coa-chosen-by-hand"]);
  });

  it("still applies the catalogue to a line nobody has touched", async () => {
    const db = financeSyncDb(seed);

    await syncSquareOrders(db.client, [invoiceOrder()]);

    expect(db.rows("invoice_line_items").map((r) => r.chart_of_accounts_id)).toEqual(["coa-taproom-sales"]);
  });

  it("leaves the invoice untouched when it cannot read what is already there", async () => {
    const db = financeSyncDb({ ...seed, invoice_line_items: handCoded("coa-chosen-by-hand") });
    db.failSelectsOn("invoice_line_items");

    const result = await syncSquareOrders(db.client, [invoiceOrder()]);

    expect(db.rows("invoice_line_items").map((r) => r.chart_of_accounts_id)).toEqual(["coa-chosen-by-hand"]);
    expect(result.synced).toBe(0);
  });
});

describe("ramp-expenses-sync: an expense", () => {
  const noCounterpartyRules = new Map<string, CounterpartyRuleRef>();
  const accountRule = new Map<string, RuleRef>([
    ["ramp-acct", { external_account_id: "ramp-acct", chart_of_accounts_id: "coa-rule" }],
  ]);

  it("keeps an account somebody pinned, over any rule that would say otherwise", () => {
    const result = resolveExpenseMapping(
      { external_account_id: "ramp-acct", counterparty_key: "gusto", mapping_source: "manual", chart_of_accounts_id: "coa-pinned" },
      accountRule,
      new Map([["gusto", { counterparty_key: "gusto", chart_of_accounts_id: "coa-counterparty", routing: "single_account" as const }]]),
    );

    expect(result).toEqual({ chart_of_accounts_id: "coa-pinned", mapping_source: "manual" });
  });

  it("keeps a pin even when it deliberately points at nothing", () => {
    const result = resolveExpenseMapping(
      { external_account_id: "ramp-acct", counterparty_key: null, mapping_source: "manual", chart_of_accounts_id: null },
      accountRule,
      noCounterpartyRules,
    );

    expect(result).toEqual({ chart_of_accounts_id: null, mapping_source: "manual" });
  });

  it("still applies a rule to an expense nobody has coded", () => {
    const result = resolveExpenseMapping(
      { external_account_id: "ramp-acct", counterparty_key: null, mapping_source: "unmapped", chart_of_accounts_id: null },
      accountRule,
      noCounterpartyRules,
    );

    expect(result).toEqual({ chart_of_accounts_id: "coa-rule", mapping_source: "rule" });
  });

  // The three above are about the upsert, which honours a pin. The prune that
  // runs after it is a second, separate way the same row can lose the same
  // decision -- it deletes outright, so no amount of care in resolveExpenseMapping
  // protects a row it picks. That is the shape of the bug these two pin.
  it("survives the prune when the feed reclassifies it, keeping the account somebody pinned", async () => {
    const fake = fakePruneClient([
      { id: "e-pinned", source_transaction_id: "bank-1", excluded_at: null, mapping_source: "manual", unmapped_accepted: false },
    ]);

    const result = await pruneReclassifiedBankExpenses(fake.client, [
      { source_transaction_id: "bank-1", flow_type: "bill_settlement" },
    ]);

    // Not deleted, and reported rather than done quietly.
    expect(fake.deleted).toEqual([]);
    expect(result.deleted).toBe(0);
    expect(result.setAside).toEqual(["bank-1"]);

    // Kept out of the statements, with a reason a bookkeeper can act on, and
    // with the coding itself untouched -- excluding is reversible, deleting is not.
    const [update] = fake.updates;
    expect(update.id).toBe("e-pinned");
    expect(update.patch.excluded_at).toBeTruthy();
    expect(String(update.patch.excluded_reason)).toContain("a bill settlement");
    expect(String(update.patch.excluded_reason)).toContain("coded by hand");
    expect(update.patch).not.toHaveProperty("chart_of_accounts_id");
    expect(update.patch).not.toHaveProperty("mapping_source");
  });

  it("survives the prune even when the pin deliberately points at nothing", async () => {
    // The other half of "keeps a pin even when it deliberately points at
    // nothing", above: the upsert honours that pin, and now so does the prune.
    const fake = fakePruneClient([
      { id: "e-null-pin", source_transaction_id: "bank-3", excluded_at: null, mapping_source: "manual", chart_of_accounts_id: null, unmapped_accepted: false },
    ]);

    const result = await pruneReclassifiedBankExpenses(fake.client, [
      { source_transaction_id: "bank-3", flow_type: "internal_transfer" },
    ]);

    expect(fake.deleted).toEqual([]);
    expect(result.setAside).toEqual(["bank-3"]);
  });

  it("is still deleted when nobody has coded it, which is what the prune is for", async () => {
    const fake = fakePruneClient([
      { id: "e-plain", source_transaction_id: "bank-2", excluded_at: null, mapping_source: "rule", unmapped_accepted: false },
    ]);

    const result = await pruneReclassifiedBankExpenses(fake.client, [
      { source_transaction_id: "bank-2", flow_type: "bill_settlement" },
    ]);

    expect(fake.deleted).toEqual(["e-plain"]);
    expect(result).toMatchObject({ deleted: 1, setAside: [] });
    expect(fake.updates).toEqual([]);
  });
});

/**
 * A client just real enough to run the prune: it answers the candidate read with
 * the given expenses rows, reports no splits and no payroll matches, and records
 * what the prune tried to delete and update.
 */
function fakePruneClient(rows: Array<Record<string, unknown>>) {
  const deleted: string[] = [];
  const updates: Array<{ id: string | null; patch: Record<string, unknown> }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (table: string): any => {
    let mode: "select" | "update" | "delete" = "select";
    let patch: Record<string, unknown> = {};
    let targetId: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b,
      update: (p: Record<string, unknown>) => { mode = "update"; patch = p; return b; },
      delete: () => { mode = "delete"; return b; },
      eq: (col: string, val: string) => { if (col === "id") targetId = val; return b; },
      in: (_col: string, vals: string[]) => { if (mode === "delete") deleted.push(...vals); return b; },
      // Thenable, because every one of these chains is awaited directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (resolve: (v: any) => unknown) => {
        if (mode === "update") { updates.push({ id: targetId, patch }); return resolve({ data: null, error: null }); }
        if (mode === "delete") return resolve({ error: null });
        // Only `expenses` has candidates; the two manual-work tables answer empty.
        return resolve({ data: table === "expenses" ? rows : [], error: null });
      },
    };
    return b;
  };

  return { client: { from } as never, deleted, updates };
}

describe("bank-transactions-sync: a bank transaction", () => {
  const bankSaysFresh = {
    source: "plaid", source_transaction_id: "txn-1", connection_id: "conn-1",
    external_account_id: "acct", amount_cents: 1000, currency_code: "USD",
    description: "ACH CREDIT", original_description: null, counterparty_name: null,
    flow_type: "unclassified", affects_pl: false, include_in_gl: false,
    chart_of_accounts_id: null, mapping_source: "unmapped",
    transaction_date: "2026-07-23", pending: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: {} as any,
  };

  it("keeps every decision made about a transaction the feed has seen before", () => {
    const kept = preserveOperatorCoding(bankSaysFresh, {
      flow_type: "deposit", affects_pl: true, include_in_gl: true,
      chart_of_accounts_id: "coa-sales", mapping_source: "manual",
    });

    expect(kept).toMatchObject({
      flow_type: "deposit", affects_pl: true, include_in_gl: true,
      chart_of_accounts_id: "coa-sales", mapping_source: "manual",
    });
  });

  it("leaves a first-time import outside the books, which is what keeps Chase out of the statements", () => {
    expect(preserveOperatorCoding(bankSaysFresh, undefined)).toMatchObject({
      include_in_gl: false, chart_of_accounts_id: null, affects_pl: false,
    });
  });
});

describe("taproom-consumption-sync: a pour", () => {
  it("records only what has not been recorded, so running it again drains nothing twice", () => {
    expect(remainingDelta(6, 6)).toBe(0);
    expect(remainingDelta(6, 4)).toBe(2);
  });

  it("never takes stock back when more was recorded than the source now reports", () => {
    expect(remainingDelta(4, 6)).toBe(0);
  });
});

describe("balance-close: a month", () => {
  it("leaves a frozen account's balance exactly as it was closed", () => {
    // Re-running the close on a month that has already been signed off must not
    // recompute it. This is the operator decision in that job: freezing is how a
    // month stops moving.
    const writes = resolveSnapshotWrites(
      [{ coaId: "coa-1", providerKey: "manualBalance" }],
      new Map<string, number | null>([["coa-1:manualBalance", 500]]),
      new Map([["coa-1", { isFrozen: true }]]),
    );

    expect(writes).toEqual([]);
  });

  it("does recompute a month still open, which is what the job is for", () => {
    const writes = resolveSnapshotWrites(
      [{ coaId: "coa-1", providerKey: "manualBalance" }],
      new Map<string, number | null>([["coa-1:manualBalance", 500]]),
      new Map([["coa-1", { isFrozen: false }]]),
    );

    expect(writes).toHaveLength(1);
  });

  // The other half of this job's answer — that re-running it leaves an existing
  // close task's status, notes and completion untouched — is already proved
  // across two calls against a stateful fake in
  // lib/finance/balances/closeTasks.test.ts, which is a stronger test than
  // anything this file would add.
});

describe("tax-tasks: a filing", () => {
  it("leaves a filing already being worked on exactly as it was", async () => {
    // tax_tasks holds a worksheet, a confirmation number, an amount paid and a
    // completion — none of which the job knows how to reproduce. A re-run must
    // create the periods that are missing and stop there.
    registerParty(stubTaxParty);
    const options = await captureUpsertOptions((client) =>
      ensureTasksForSchedule(client, stubSchedule(), new Date("2026-07-05T12:00:00Z"), 45),
    );

    expect(options).toMatchObject({ ignoreDuplicates: true });
  });
});

describe("payroll-advance: a pay period", () => {
  it("declines to create a period that already exists", async () => {
    const options = await captureUpsertOptions((client) => runPayrollAdvance(client));

    expect(options).toMatchObject({ ignoreDuplicates: true });
  });
});

// ── marketing-deliveries: a post ────────────────────────────────────────────
// This job's answer is YES, and it is proved in lib/marketing/worker.test.ts
// ("re-running the job", plus the whole "two workers running at once" block)
// rather than here — the same arrangement as balance-close above, and for a
// second reason on top of it.
//
// The reason is the marketing import boundary. scripts/check-marketing-boundary
// .mjs rule 1 says nothing outside marketing imports marketing, and this file is
// outside it. The one named exception is lib/cron/jobs/marketingDeliveries.ts,
// which exists precisely so that the seam is one mounting file and not every
// module that would like to reach in — a test included. Widening the exception
// to cover this file would trade a real boundary for a cross-reference, so the
// cross-reference wins.
//
// The answer itself, for the record: re-running publishes nothing a person has
// already dealt with. The claim matches `status = 'scheduled'` and nothing else,
// so pending, publishing, published, failed and skipped deliveries are all
// invisible to it; a failed one stays failed until somebody presses Retry, and
// a scheduled one that already carries external_ids is handed them and comes
// back `reused` rather than posted a second time.
