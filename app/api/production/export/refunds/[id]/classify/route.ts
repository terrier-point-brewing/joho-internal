import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import { classifyRefund, RefundError } from "@/lib/finance/issueRefund";
import type { RefundReason, RefundSelection } from "@/lib/finance/refundPlanner";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const REASONS: RefundReason[] = [
  "price_correction",
  "goods_returned",
  "never_delivered",
  "deposit_reduction",
];

/**
 * POST — explain a refund that came in from Square without line detail.
 *
 * No money moves here; Square already moved it. This supplies the reason and
 * the lines, which re-posts the GL onto the original invoice lines' accounts and
 * runs the same inventory/excise consequences an app-issued refund would have.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { id } = await params;
  const body = await req.json();

  const reason = body.reason as RefundReason | undefined;
  if (!reason || !REASONS.includes(reason)) {
    return NextResponse.json({ error: "A refund reason is required." }, { status: 400 });
  }
  if (!body.invoice_id) {
    return NextResponse.json({ error: "An invoice is required." }, { status: 400 });
  }

  try {
    const user = await getSessionUser();
    const result = await classifyRefund(supabase, {
      refundId: id,
      invoiceId: body.invoice_id as string,
      reason,
      selections: (body.selections ?? []) as RefundSelection[],
      note: body.note ?? null,
      userId: user?.user.id ?? null,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof RefundError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Classification failed" },
      { status: 500 },
    );
  }
}
