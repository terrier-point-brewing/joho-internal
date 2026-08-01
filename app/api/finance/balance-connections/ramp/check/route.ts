/**
 * POST /api/finance/balance-connections/ramp/check   body { connectionId }
 *   Reads one month end's balance from Ramp right now, records the outcome on
 *   the connection, and reports it back.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Without it, connecting an account writes a row and proves nothing. The first
 * time anything actually calls Ramp is the month-end snapshot, which can be
 * weeks away -- so a missing scope, a wrong account or a changed response shape
 * would surface as a silently unsourced account during close, at the worst
 * possible moment and with no obvious cause.
 *
 * ── It runs the real read, not a lighter one ─────────────────────────────────
 * `readRampBalance` is the same function the provider's compute() calls, on the
 * same window, applying the same exact-date and currency rules. A check with
 * its own simpler query could pass while the real read fails, which is the one
 * outcome a validation exists to rule out.
 *
 * The period checked is the most recently COMPLETED month, because that is the
 * first period the snapshot would write and the one whose data must exist. The
 * current month is deliberately not used: mid-month there is no month-end row
 * to find, so it would fail for a healthy connection.
 *
 * ── It writes no balance ─────────────────────────────────────────────────────
 * The figure is returned for the operator to eyeball against Ramp and is not
 * stored. gl_account_balances has exactly one writer -- the monthly snapshot,
 * which owns the frozen-period rules. A second write path from a Settings
 * button is how those rules start being bypassed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getConnection, recordSyncResult } from "@/lib/finance/balances/connections";
import { readRampBalance } from "@/lib/finance/balances/providers/rampBalance";
// The SAME helper the balance-close cron uses to pick its period, so the check
// cannot validate a month the snapshot is not reading.
import { mostRecentlyEndedMonthEnd } from "@/lib/finance/balances/periods";
import { todayLocalDate } from "@/lib/utils/datetime";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const { connectionId } = (await req.json()) as { connectionId?: string };
    if (typeof connectionId !== "string" || connectionId.trim() === "") {
      return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    // getConnection, not getConnectionWithSecrets: Ramp authenticates from env,
    // so there is no per-connection secret to fetch and no reason to load one.
    const connection = await getConnection(supabase, connectionId);
    if (!connection) {
      return NextResponse.json({ error: "That connection no longer exists." }, { status: 404 });
    }
    if (connection.provider !== "ramp") {
      return NextResponse.json({ error: "That connection is not a Ramp connection." }, { status: 400 });
    }

    const today = todayLocalDate();
    const periodEnd = mostRecentlyEndedMonthEnd(today);
    const result = await readRampBalance(connection, periodEnd, today);

    // Unlike the provider, this route lets a failed status write surface: the
    // operator is standing at the screen waiting for an answer, so "the check
    // passed but we could not save that" is information, not noise.
    await recordSyncResult(
      supabase,
      connectionId,
      result.ok ? { ok: true } : { ok: false, error: result.reason },
    );

    return NextResponse.json(
      result.ok
        ? { ok: true, periodEnd, balanceCents: result.balanceCents, asOfDate: result.asOfDate }
        : { ok: false, periodEnd, reason: result.reason },
    );
  } catch (err) {
    return apiError(err);
  }
}
