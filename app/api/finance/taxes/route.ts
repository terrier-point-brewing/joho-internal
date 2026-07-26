import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  const supabase = await createSupabaseServerClient();

  // Pull export_transactions within the date range.
  let query = supabase
    .from("export_transactions")
    .select(`
      id, batch_id, channel, variant_label, quantity,
      volume_bbl, total_excise_tax_usd,
      created_at
    `)
    .order("created_at", { ascending: false });

  if (from) query = query.gte("created_at", from);
  if (to)   query = query.lte("created_at", to + "T23:59:59");

  const { data: exports, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (exports ?? []).map((e) => ({
    id:           e.id,
    batch_id:     e.batch_id,
    channel:      e.channel,
    variant_label: e.variant_label,
    quantity:     e.quantity,
    volume_bbl:   e.volume_bbl,
    total_excise_tax_usd: e.total_excise_tax_usd,
    date:         e.created_at,
  }));

  const totals = rows.reduce(
    (acc, r) => ({
      volume_bbl:           acc.volume_bbl           + r.volume_bbl,
      total_excise_tax_usd: acc.total_excise_tax_usd + r.total_excise_tax_usd,
    }),
    { volume_bbl: 0, total_excise_tax_usd: 0 }
  );

  return NextResponse.json({ rows, totals });
}
