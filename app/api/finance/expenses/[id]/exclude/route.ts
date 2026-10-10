/**
 * Manual duplicate exclusion for one expense. An excluded row is dropped from
 * every financial statement (see financials/expenseFilters.ts) but stays visible
 * and reversible in the Transactions ledger. Reason is required: exclusion
 * silently removes money from reports, so the audit trail is not optional.
 *
 * Manager+ only, service-role client. The excluded_* columns are absent from
 * ExpenseRecord, so the Ramp sync upsert never clobbers them.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser, requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { excludeExpense } from "@/lib/finance/expenseExclusion";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const { id } = await params;
  const body = (await req.json()) as { reason?: string };
  const reason = (body.reason ?? "").trim();
  if (!reason) return NextResponse.json({ error: "A reason is required to exclude a transaction" }, { status: 400 });

  const sb = createSupabaseAdminClient();
  // getSessionUser returns { user, role } — the id is on .user, not the root.
  const session = await getSessionUser();
  const result = await excludeExpense(sb, { id, reason, userId: session?.user.id ?? null });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json(result.row);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const { id } = await params;
  const sb = createSupabaseAdminClient();
  const { data, error } = await sb
    .from("expenses")
    .update({ excluded_at: null, excluded_reason: null, excluded_by: null })
    .eq("id", id)
    .select("id, excluded_at, excluded_reason")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}
