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
import { getSessionUser, requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id } = await params;
  const body = (await req.json()) as { reason?: string };
  const reason = (body.reason ?? "").trim();
  if (!reason) return NextResponse.json({ error: "A reason is required to exclude a transaction" }, { status: 400 });

  const sb = createSupabaseAdminClient();

  // A split expense codes through its split lines; excluding it would strand
  // them. Make the operator clear the split first rather than silently winning.
  const { data: splits, error: splitErr } = await sb
    .from("expense_gl_splits").select("id").eq("expense_id", id).limit(1);
  if (splitErr) return NextResponse.json({ error: splitErr.message }, { status: 500 });
  if (splits && splits.length > 0) {
    return NextResponse.json({ error: "Clear this transaction's GL split before excluding it" }, { status: 409 });
  }

  // getSessionUser returns { user, role } — the id is on .user, not the root.
  const session = await getSessionUser();
  const { data, error } = await sb
    .from("expenses")
    .update({ excluded_at: new Date().toISOString(), excluded_reason: reason, excluded_by: session?.user.id ?? null })
    .eq("id", id)
    .select("id, excluded_at, excluded_reason")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

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
