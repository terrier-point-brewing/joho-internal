import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { getPriorPeriodComparison } from "@/lib/payroll/priorPeriodTotals";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requirePermission(CAP.payrollRead); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  try {
    return NextResponse.json(await getPriorPeriodComparison(supabase, id));
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }
}
