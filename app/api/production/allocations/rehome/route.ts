import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { executeRehome, listHomes, drawsFromBody } from "@/lib/production/rehome";

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
// { target_allocation_id, transaction_ids?,
//   draws: [{ source: { kind: "unallocated" } | { kind: "allocation", allocation_id }, bbl, refund_cents? }] }
//   — or the older single source + bbl (+ refund_cents).
// Moves the drawn share into the target allocation (raising its booking) and,
// when given, credits already-shipped over-delivery / ad-hoc rows to it. A
// source whose deposit is paid is refunded the matching slice first;
// `refund_cents` is the amount the operator confirmed, to the cent, and
// without it such a source is refused.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }
  const supabase = await createSupabaseServerClient();
  const body = await req.json().catch(() => ({}));
  const targetAllocationId = body.target_allocation_id as string | undefined;
  if (!targetAllocationId) return NextResponse.json({ error: "target_allocation_id is required" }, { status: 400 });
  let draws;
  try { draws = drawsFromBody(body); } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "source and a positive bbl are required" }, { status: 400 });
  }
  const transactionIds = Array.isArray(body.transaction_ids) ? body.transaction_ids.filter((x: unknown) => typeof x === "string") : undefined;

  try {
    // The shipped rows are credited with the first draw; later draws only move share.
    let result = null;
    for (const [i, d] of draws.entries()) {
      result = await executeRehome(supabase, {
        targetAllocationId, source: d.source, bbl: d.bbl, refund: d.refund ?? null,
        transactionIds: i === 0 ? transactionIds : undefined,
      });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Re-home failed" }, { status: 422 });
  }
}
