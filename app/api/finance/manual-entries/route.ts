// Manual financial entries API — the auditable replacement for
// app/api/manual-entries/route.ts (retired in Task 5). Backs Finance >
// Transactions' manual-entry UI (Task 4).
//
// Two kinds share one table (see lib/finance/manualEntries.ts):
//   * "flow"    — a P&L amount over a date RANGE (startDate..endDate).
//   * "balance" — a balance-sheet amount AS OF a month end (asOfDate).
import { NextRequest, NextResponse } from "next/server";
// Admin client, not the server client: manual_entries' RLS deliberately covers
// only entry_kind='flow' (see 20260902_manual_entries.sql). Balance rows carry
// bank and equity figures and are service-role-only, so a session-scoped client
// would silently read zero of them here. Authorization is enforced in this
// route by requirePermission on every verb -- the same arrangement the
// chart-of-accounts and expenses routes use.
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requirePermission, CAP } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import {
  validateManualEntry,
  type ManualEntryInput,
  type ManualEntryKind,
  type ManualEntryRecord,
} from "@/lib/finance/manualEntries";
import { parseManualEntryFilter } from "@/lib/finance/manualEntryFilters";
// Balance-sheet close tasks close themselves as soon as the corresponding
// balance appears -- see lib/finance/balances/closeTasks.ts's header. Never
// let a reconciler failure fail the entry write below: the entry is the
// user's data, the task is derived bookkeeping that the next
// balance-close cron run will catch regardless.
import { reconcileCloseTasks } from "@/lib/finance/balances/closeTasks";

export const dynamic = "force-dynamic";

const SELECT_COLUMNS =
  "id, entry_kind, chart_of_accounts_id, start_date, end_date, as_of_date, amount_cents, label, note, created_at, created_by, updated_at, updated_by";

/** Row shape returned by SELECT_COLUMNS — snake_case, matching the table DDL. */
interface ManualEntryRow {
  id: string;
  entry_kind: "flow" | "balance";
  chart_of_accounts_id: string;
  start_date: string | null;
  end_date: string | null;
  as_of_date: string | null;
  amount_cents: number;
  label: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

function toRecord(row: ManualEntryRow): ManualEntryRecord {
  return {
    id: row.id,
    entryKind: row.entry_kind,
    chartOfAccountsId: row.chart_of_accounts_id,
    startDate: row.start_date,
    endDate: row.end_date,
    asOfDate: row.as_of_date,
    amountCents: row.amount_cents,
    label: row.label,
    note: row.note,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Postgres 23505 message for the partial unique index carries the constraint name verbatim. */
const DUPLICATE_BALANCE_CONSTRAINT = "manual_entries_one_balance_per_period";

function isDuplicateBalanceError(error: { code?: string; message?: string }): boolean {
  return error.code === "23505" && !!error.message?.includes(DUPLICATE_BALANCE_CONSTRAINT);
}

/**
 * Fires reconcileCloseTasks for a just-written balance entry so its close
 * task clears immediately instead of waiting for the next balance-close
 * cron run. A reconciler failure is logged and swallowed -- it must never
 * fail the entry write that already succeeded.
 */
async function reconcileAfterWrite(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  record: ManualEntryRecord,
): Promise<void> {
  if (record.entryKind !== "balance" || !record.asOfDate) return;
  try {
    await reconcileCloseTasks(supabase, record.asOfDate);
  } catch (err) {
    console.error("[manual-entries] reconcileCloseTasks failed", { asOfDate: record.asOfDate, err });
  }
}

/**
 * Builds the insert/update row for a *validated* input. Always assigns all
 * three date columns (nulling out the pair that doesn't apply to this kind)
 * so the return type is a single object shape, not a union — the Supabase
 * insert/update overloads reject a union row type.
 */
function toRow(input: ManualEntryInput, author: { created_by?: string; updated_by?: string }) {
  return {
    entry_kind: input.entryKind,
    chart_of_accounts_id: input.chartOfAccountsId,
    start_date: input.entryKind === "flow" ? input.startDate : null,
    end_date: input.entryKind === "flow" ? input.endDate : null,
    as_of_date: input.entryKind === "balance" ? input.asOfDate : null,
    amount_cents: input.amountCents,
    label: input.label ?? null,
    note: input.note ?? null,
    ...author,
  };
}

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();

  try {
    const { searchParams } = req.nextUrl;
    const filter = parseManualEntryFilter(searchParams.get("kind"), searchParams.get("year"));

    let query = supabase
      .from("manual_entries")
      .select(SELECT_COLUMNS)
      .order("created_at", { ascending: false });

    switch (filter.type) {
      case "none":
        break;
      case "kind":
        query = query.eq("entry_kind", filter.kind);
        break;
      case "kind-year":
        query = query.eq("entry_kind", filter.kind);
        query =
          filter.kind === "flow"
            ? query.lte("start_date", filter.yearEnd).gte("end_date", filter.yearStart)
            : query.gte("as_of_date", filter.yearStart).lte("as_of_date", filter.yearEnd);
        break;
      case "year":
        query = query.or(filter.or);
        break;
    }

    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json((data ?? []).map((row) => toRecord(row as ManualEntryRow)));
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();

  try {
    const body = (await req.json()) as ManualEntryInput;

    const validation = validateManualEntry(body);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const row = toRow(body, { created_by: session.user.id });

    const { data, error } = await supabase
      .from("manual_entries")
      .insert(row)
      .select(SELECT_COLUMNS)
      .single();

    if (error) {
      if (isDuplicateBalanceError(error)) {
        return NextResponse.json(
          { error: "A balance already exists for this account and period — edit it instead." },
          { status: 409 },
        );
      }
      throw error;
    }

    const record = toRecord(data as ManualEntryRow);
    await reconcileAfterWrite(supabase, record);

    return NextResponse.json(record, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

/** Sparse-PATCH body: `{ id } & Partial<ManualEntryInput>`, flattened across both
 * kinds' fields since `Partial` over the discriminated `ManualEntryInput` union
 * would drop the kind-specific date fields. */
interface ManualEntryPatchBody {
  id?: string;
  entryKind?: ManualEntryKind;
  chartOfAccountsId?: string;
  startDate?: string | null;
  endDate?: string | null;
  asOfDate?: string | null;
  amountCents?: number;
  label?: string | null;
  note?: string | null;
}

/** Maps ManualEntryInput field names to their manual_entries column names. */
const PATCHABLE_COLUMNS: Record<keyof Omit<ManualEntryPatchBody, "id">, string> = {
  entryKind: "entry_kind",
  chartOfAccountsId: "chart_of_accounts_id",
  startDate: "start_date",
  endDate: "end_date",
  asOfDate: "as_of_date",
  amountCents: "amount_cents",
  label: "label",
  note: "note",
};

export async function PATCH(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();

  try {
    const body = (await req.json()) as ManualEntryPatchBody;
    const { id, ...patch } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const { data: existingRow, error: fetchError } = await supabase
      .from("manual_entries")
      .select(SELECT_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existingRow) {
      return NextResponse.json({ error: "Manual entry not found" }, { status: 404 });
    }

    const existing = toRecord(existingRow as ManualEntryRow);

    // Merge only the fields the caller actually supplied over the existing
    // record — an absent key keeps its current value; an explicit `null` on
    // a nullable field clears it. Validation then runs on the full
    // post-merge state, keeping validateManualEntry authoritative.
    const merged: ManualEntryInput = {
      entryKind: "entryKind" in patch ? (patch.entryKind as ManualEntryKind) : existing.entryKind,
      chartOfAccountsId:
        "chartOfAccountsId" in patch ? (patch.chartOfAccountsId as string) : existing.chartOfAccountsId,
      startDate: "startDate" in patch ? (patch.startDate ?? null) : existing.startDate,
      endDate: "endDate" in patch ? (patch.endDate ?? null) : existing.endDate,
      asOfDate: "asOfDate" in patch ? (patch.asOfDate ?? null) : existing.asOfDate,
      amountCents: "amountCents" in patch ? (patch.amountCents as number) : existing.amountCents,
      label: "label" in patch ? (patch.label ?? null) : existing.label,
      note: "note" in patch ? (patch.note ?? null) : existing.note,
    } as ManualEntryInput;

    const validation = validateManualEntry(merged);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const mergedRow = toRow(merged, { updated_by: session.user.id });

    // Update only the columns actually supplied in the patch (plus updated_by).
    // A kind switch (`entryKind` supplied) must also rewrite all three date
    // columns together, since toRow nulls out the pair that no longer applies.
    const updateRow: Record<string, unknown> = { updated_by: session.user.id };
    for (const key of Object.keys(patch) as (keyof Omit<ManualEntryPatchBody, "id">)[]) {
      const column = PATCHABLE_COLUMNS[key];
      if (column) updateRow[column] = mergedRow[column as keyof typeof mergedRow];
    }
    if ("entryKind" in patch) {
      updateRow.start_date = mergedRow.start_date;
      updateRow.end_date = mergedRow.end_date;
      updateRow.as_of_date = mergedRow.as_of_date;
    }

    const { data, error } = await supabase
      .from("manual_entries")
      .update(updateRow)
      .eq("id", id)
      .select(SELECT_COLUMNS)
      .single();

    if (error) {
      if (isDuplicateBalanceError(error)) {
        return NextResponse.json(
          { error: "A balance already exists for this account and period — edit it instead." },
          { status: 409 },
        );
      }
      throw error;
    }

    const record = toRecord(data as ManualEntryRow);
    await reconcileAfterWrite(supabase, record);

    return NextResponse.json(record);
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();

  try {
    const { id } = (await req.json()) as { id?: string };
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const { error } = await supabase.from("manual_entries").delete().eq("id", id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
