// Manual financial entries API — the auditable replacement for
// app/api/manual-entries/route.ts (retired in Task 5). Backs Finance >
// Transactions' manual-entry UI (Task 4).
//
// Two kinds share one table (see lib/finance/manualEntries.ts):
//   * "flow"    — a P&L amount over a date RANGE (startDate..endDate).
//   * "balance" — a balance-sheet amount AS OF a month end (asOfDate).
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePermission, CAP } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import {
  validateManualEntry,
  type ManualEntryInput,
  type ManualEntryRecord,
} from "@/lib/finance/manualEntries";

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

  const supabase = await createSupabaseServerClient();

  try {
    const { searchParams } = req.nextUrl;
    const kindParam = searchParams.get("kind");
    const kind = kindParam === "flow" || kindParam === "balance" ? kindParam : null;
    const yearParam = searchParams.get("year");
    const yearNum = yearParam !== null ? Number(yearParam) : NaN;
    const year = Number.isInteger(yearNum) ? yearNum : null;

    let query = supabase
      .from("manual_entries")
      .select(SELECT_COLUMNS)
      .order("created_at", { ascending: false });

    if (kind) query = query.eq("entry_kind", kind);

    if (year !== null) {
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year}-12-31`;
      if (kind === "flow") {
        query = query.lte("start_date", yearEnd).gte("end_date", yearStart);
      } else if (kind === "balance") {
        query = query.gte("as_of_date", yearStart).lte("as_of_date", yearEnd);
      } else {
        // No kind filter: match either a flow entry overlapping the year, or a
        // balance entry dated within it.
        query = query.or(
          `and(entry_kind.eq.flow,start_date.lte.${yearEnd},end_date.gte.${yearStart}),` +
          `and(entry_kind.eq.balance,as_of_date.gte.${yearStart},as_of_date.lte.${yearEnd})`,
        );
      }
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

  const supabase = await createSupabaseServerClient();

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

    return NextResponse.json(toRecord(data as ManualEntryRow), { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  try {
    const body = (await req.json()) as { id?: string } & Partial<ManualEntryInput>;
    const { id, ...rest } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const input = rest as ManualEntryInput;
    const validation = validateManualEntry(input);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const row = toRow(input, { updated_by: session.user.id });

    const { data, error } = await supabase
      .from("manual_entries")
      .update(row)
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

    return NextResponse.json(toRecord(data as ManualEntryRow));
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

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
