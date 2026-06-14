import { NextRequest, NextResponse } from "next/server";
import { requireRole, getSessionUser } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// GET /api/finance/chart-of-accounts — list all accounts
export async function GET() {
  try { await requireRole("viewer"); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("chart_of_accounts")
    .select("*")
    .order("account_number", { ascending: true, nullsFirst: false })
    .order("account_name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export interface CoARow {
  account_name: string;
  account_number: string | null;
  account_type: string;
  detail_type: string | null;
  description: string | null;
  is_active: boolean;
  parent_id?: string | null;
  statement_section?: string | null;
}

// POST /api/finance/chart-of-accounts — sync accounts from CSV
// Upserts all provided accounts, then deletes any accounts not in the provided set.
// The "manual add" path sends a single-element array and sets keepExtras=true
// so manually added accounts are never auto-deleted by a bulk upload.
export async function POST(req: NextRequest) {
  try { await requireRole("manager"); } catch (res) { return res as Response; }

  const session = await getSessionUser();
  const body = await req.json() as { accounts: CoARow[]; keepExtras?: boolean };

  if (!Array.isArray(body.accounts) || body.accounts.length === 0) {
    return NextResponse.json({ error: "No accounts provided" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  const rows = body.accounts.map((a) => ({
    account_name:      a.account_name,
    account_number:    a.account_number ?? null,
    account_type:      a.account_type,
    detail_type:       a.detail_type ?? null,
    description:       a.description ?? null,
    is_active:         a.is_active ?? true,
    parent_id:         a.parent_id ?? null,
    statement_section: a.statement_section ?? null,
    uploaded_by:       session?.user.id ?? null,
  }));

  const { data, error } = await supabase
    .from("chart_of_accounts")
    .upsert(rows, { onConflict: "account_name" })
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let deleted = 0;
  if (!body.keepExtras && data.length > 0) {
    const keptIds = data.map((r) => r.id);
    const { data: deletedRows, error: delError } = await supabase
      .from("chart_of_accounts")
      .delete()
      .not("id", "in", `(${keptIds.join(",")})`)
      .select("id");
    if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });
    deleted = deletedRows?.length ?? 0;
  }

  return NextResponse.json({ upserted: data.length, deleted });
}

// PATCH /api/finance/chart-of-accounts — update individual account fields
export async function PATCH(req: NextRequest) {
  try { await requireRole("manager"); } catch (res) { return res as Response; }

  const body = await req.json() as {
    id: string;
    account_name?: string;
    account_number?: string | null;
    account_type?: string;
    detail_type?: string | null;
    description?: string | null;
    is_active?: boolean;
    parent_id?: string | null;
    statement_section?: string | null;
  };

  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const updates: Record<string, unknown> = {};
  const fields = ["account_name","account_number","account_type","detail_type","description","is_active","parent_id","statement_section"] as const;
  for (const f of fields) {
    if (f in body) updates[f] = (body as Record<string, unknown>)[f];
  }

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("chart_of_accounts").update(updates).eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
