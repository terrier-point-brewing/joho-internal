import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { executeRehome, listHomes } from "@/lib/production/rehome";

export const dynamic = "force-dynamic";

// GET /api/production/allocations/rehome?batch_id=&target_allocation_id=
// Where on this batch the extra share could come from.
export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.exportRead); } catch (res) { return res as Response; }
  const batchId = req.nextUrl.searchParams.get("batch_id");
  const target = req.nextUrl.searchParams.get("target_allocation_id");
  if (!batchId) return NextResponse.json({ error: "batch_id is required" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  return NextResponse.json(await listHomes(supabase, { batchId, targetAllocationId: target }));
}

// POST /api/production/allocations/rehome
// { target_allocation_id, source: { kind: "unallocated" } | { kind: "allocation", allocation_id },
//   bbl, transaction_ids? }
// Moves `bbl` of the batch's share into the target allocation (raising its
// booking) and, when given, credits already-shipped over-delivery / ad-hoc
// rows to it. Refuses when the source's deposit is paid — that is the
// refund flow's job.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }
  const supabase = await createSupabaseServerClient();
  const body = await req.json().catch(() => ({}));
  const targetAllocationId = body.target_allocation_id as string | undefined;
  const bbl = Number(body.bbl);
  const src = body.source as { kind?: string; allocation_id?: string } | undefined;
  if (!targetAllocationId || !(bbl > 0) || !src?.kind) {
    return NextResponse.json({ error: "target_allocation_id, source and a positive bbl are required" }, { status: 400 });
  }
  const source = src.kind === "unallocated"
    ? { kind: "unallocated" as const }
    : src.allocation_id ? { kind: "allocation" as const, allocationId: src.allocation_id } : null;
  if (!source) return NextResponse.json({ error: "source.allocation_id is required for an allocation source" }, { status: 400 });

  try {
    const result = await executeRehome(supabase, {
      targetAllocationId, source, bbl,
      transactionIds: Array.isArray(body.transaction_ids) ? body.transaction_ids.filter((x: unknown) => typeof x === "string") : undefined,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Re-home failed" }, { status: 422 });
  }
}
