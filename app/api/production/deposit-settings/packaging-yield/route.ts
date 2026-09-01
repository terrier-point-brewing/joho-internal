import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_PACKAGING_YIELD_PCT } from "@/lib/production/exportIngredientDeposit";

export const dynamic = "force-dynamic";

/**
 * How much of the beer still in tank is expected to survive packaging.
 *
 * The ingredient deposit divides a shipment by the batch's projected yield, and
 * beer that has not been packaged yet has its loss ahead of it. Counting it at
 * today's tank volume inflates the denominator, so every invoice cut mid-run
 * undercharges — permanently, because no invoice is ever restated. This factor
 * is what shrinks it. See lib/production/exportIngredientDeposit.ts.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "deposit_packaging_yield_pct")
    .maybeSingle();

  if (error || !data) return NextResponse.json({ pct: DEFAULT_PACKAGING_YIELD_PCT });
  const pct = Number(data.value);
  return NextResponse.json({
    pct: Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : DEFAULT_PACKAGING_YIELD_PCT,
  });
}

export async function PUT(req: NextRequest) {
  try { await requirePermission(CAP.productionSettingsManage); } catch (res) { return res as Response; }

  const { pct } = await req.json() as { pct: number };
  // The ceiling is 100: beer cannot gain volume in the packaging line, and 100
  // is also the safe end — the factor is a denominator, so a higher value
  // charges less. The floor is a sanity rail: below 50% the deposit would start
  // billing partners for grain that was never theirs, which is the one direction
  // this calculation must never err in.
  if (!Number.isFinite(pct) || pct < 50 || pct > 100) {
    return NextResponse.json({ error: "pct must be between 50 and 100" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("system_settings")
    .upsert({ key: "deposit_packaging_yield_pct", value: pct });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pct });
}
