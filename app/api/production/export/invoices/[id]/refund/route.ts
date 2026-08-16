import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import {
  issueRefund,
  previewRefund,
  loadRefundableLines,
  RefundError,
} from "@/lib/finance/issueRefund";
import { lineBasis, type RefundReason, type RefundSelection } from "@/lib/finance/refundPlanner";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const REASONS: RefundReason[] = [
  "price_correction",
  "goods_returned",
  "never_delivered",
  "deposit_reduction",
];

/**
 * GET — the invoice's lines with the basis the planner will apply to each, so
 * the modal renders quantity inputs only where a quantity is meaningful. The
 * modal never decides this for itself; `lineBasis` is the same function the
 * server enforces with.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { id } = await params;

  try {
    const lines = await loadRefundableLines(supabase, id);
    const { data: refunds } = await supabase
      .from("square_refunds")
      .select("id, amount_cents, reason_code, refunded_at, status")
      .eq("invoice_id", id)
      .order("refunded_at", { ascending: false });

    const { data: rows } = await supabase
      .from("invoice_line_items")
      .select("id, line_item_name, variation_name, note, category")
      .eq("invoice_id", id);
    const labelById = new Map((rows ?? []).map((r) => [r.id, r]));

    return NextResponse.json({
      lines: lines.map((l) => {
        const meta = labelById.get(l.id);
        return {
          id: l.id,
          label: meta?.note || meta?.line_item_name || "Line item",
          category: l.category,
          basis: lineBasis(l),
          quantity: l.quantity,
          totalCents: l.totalCents,
          hasVolume: l.volumeBbl != null,
        };
      }),
      priorRefunds: refunds ?? [],
    });
  } catch (e) {
    return errorResponse(e);
  }
}

interface RefundBody {
  reason?: string;
  selections?: RefundSelection[];
  note?: string | null;
  /** Plan only — no money moves, no rows are written. */
  preview?: boolean;
}

/**
 * POST — issue a real Square refund against this invoice, or (with
 * `preview: true`) just plan one. Preview and issue share the planner, so the
 * modal can never show a total the server would reject.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { id } = await params;
  const body = (await req.json()) as RefundBody;

  const reason = body.reason as RefundReason | undefined;
  if (!reason || !REASONS.includes(reason)) {
    return NextResponse.json({ error: "A refund reason is required." }, { status: 400 });
  }
  const selections = Array.isArray(body.selections) ? body.selections : [];

  try {
    if (body.preview) {
      const plan = await previewRefund(supabase, { invoiceId: id, reason, selections });
      return plan.ok
        ? NextResponse.json({ plan })
        : NextResponse.json({ error: plan.error }, { status: 400 });
    }

    const user = await getSessionUser();
    try {
      const result = await issueRefund(supabase, {
        invoiceId: id,
        reason,
        selections,
        note: body.note ?? null,
        userId: user?.user.id ?? null,
      });
      return NextResponse.json(result);
    } catch (e) {
      return errorResponse(e, true);
    }
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * `moneyMoved` tells the caller whether retrying is safe or would refund the
 * customer a second time. A `RefundError` knows its own answer; an unrecognised
 * error only gets the cautious one when a refund was actually in flight —
 * `refundAttempted` is false for reads and previews, which move nothing.
 */
function errorResponse(e: unknown, refundAttempted = false) {
  if (e instanceof RefundError) {
    return NextResponse.json({ error: e.message, moneyMoved: e.moneyMoved }, { status: e.status });
  }
  return NextResponse.json(
    { error: e instanceof Error ? e.message : "Refund failed", moneyMoved: refundAttempted },
    { status: 500 },
  );
}
