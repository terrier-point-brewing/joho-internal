import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Federal and NC excise tax rates
const FEDERAL_EXCISE_PER_BBL = 3.50;   // USD/BBL (craft < 60k BBL/yr)
const NC_EXCISE_PER_GAL      = 0.62;   // USD/gal (NC beer tax)
const BBL_TO_GAL             = 31;

export async function GET(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  const supabase = await createSupabaseServerClient();

  // Pull batch_exports within the date range, joined to their transfer date.
  let query = supabase
    .from("batch_exports")
    .select(`
      id, batch_id, channel, product_type, quantity, unit,
      volume_bbl, federal_excise_tax_usd, state_excise_tax_usd,
      created_at,
      batch_transfers!transfer_id ( transferred_at )
    `)
    .order("created_at", { ascending: false });

  if (from) query = query.gte("created_at", from);
  if (to)   query = query.lte("created_at", to + "T23:59:59");

  const { data: exports, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (exports ?? []).map((e) => {
    // Use stored values if available, otherwise recalculate
    const bbl      = e.volume_bbl ?? 0;
    const federal  = e.federal_excise_tax_usd  ?? Math.round(bbl * FEDERAL_EXCISE_PER_BBL * 100) / 100;
    const state    = e.state_excise_tax_usd    ?? Math.round(bbl * BBL_TO_GAL * NC_EXCISE_PER_GAL * 100) / 100;
    return {
      id:           e.id,
      batch_id:     e.batch_id,
      channel:      e.channel,
      product_type: e.product_type,
      quantity:     e.quantity,
      unit:         e.unit,
      volume_bbl:   bbl,
      federal_excise_tax_usd: federal,
      state_excise_tax_usd:   state,
      total_excise_tax_usd:   Math.round((federal + state) * 100) / 100,
      date:         e.created_at,
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      volume_bbl:             acc.volume_bbl             + r.volume_bbl,
      federal_excise_tax_usd: acc.federal_excise_tax_usd + r.federal_excise_tax_usd,
      state_excise_tax_usd:   acc.state_excise_tax_usd   + r.state_excise_tax_usd,
      total_excise_tax_usd:   acc.total_excise_tax_usd   + r.total_excise_tax_usd,
    }),
    { volume_bbl: 0, federal_excise_tax_usd: 0, state_excise_tax_usd: 0, total_excise_tax_usd: 0 }
  );

  return NextResponse.json({ rows, totals });
}
