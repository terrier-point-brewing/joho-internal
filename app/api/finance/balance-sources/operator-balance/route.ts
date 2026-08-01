/**
 * POST /api/finance/balance-sources/operator-balance
 *   { coaId, asOfDate, amountCents }
 *
 * Writes the figure an `operatorBalance` setup field asks for -- the whole
 * of manual entry's setup, and the anchor half of the Square balance's.
 *
 * Set-or-replace, unlike POST /api/finance/manual-entries which answers 409
 * when a balance already exists. Re-entering a month's figure after checking it
 * again is the normal operation here, not a conflict. Both go through the same
 * validator and the same close-task reconciler; see lib/finance/balances/
 * operatorBalance.ts for why this is a second entry point and not a second
 * store.
 *
 * It is deliberately NOT a config write on balance-sources: a dollar value does
 * not belong in a rules table, and putting it there would lose the audit trail,
 * the Manual Entries screen and the one-balance-per-period guard that
 * manual_entries already provides.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { setOperatorBalance } from "@/lib/finance/balances/operatorBalance";

export const dynamic = "force-dynamic";

interface Body {
  coaId?: string;
  asOfDate?: string;
  amountCents?: number;
  label?: string;
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as Body;

    if (typeof body.coaId !== "string" || body.coaId.trim() === "") {
      return NextResponse.json({ error: "coaId is required" }, { status: 400 });
    }
    if (typeof body.asOfDate !== "string" || body.asOfDate.trim() === "") {
      return NextResponse.json({ error: "asOfDate is required" }, { status: 400 });
    }
    if (typeof body.amountCents !== "number" || !Number.isFinite(body.amountCents)) {
      return NextResponse.json({ error: "amountCents is required" }, { status: 400 });
    }

    const result = await setOperatorBalance(
      createSupabaseAdminClient(),
      {
        coaId: body.coaId.trim(),
        asOfDate: body.asOfDate.trim(),
        amountCents: Math.round(body.amountCents),
        label: body.label,
      },
      session.user.id,
    );

    // A validation failure is the caller's problem to fix, so it comes back as
    // a 400 with the validator's own sentence rather than a generic message.
    return result.ok ? NextResponse.json(result) : NextResponse.json({ error: result.error }, { status: 400 });
  } catch (err) {
    return apiError(err);
  }
}
