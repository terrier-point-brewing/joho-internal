/**
 * POST /api/finance/balance-close/recompute
 *   { action: "preview" | "close-period", periodEnd, reason? }
 *
 * The two actions that run a FULL recalculation — every provider, including
 * live reads against Ramp, Plaid and Square — split out of
 * ../route.ts so they occupy their own serverless function.
 *
 * ── Why a second route ───────────────────────────────────────────────────────
 * A Vercel route file is a function, and a function is a pool of instances.
 * When preview/close lived beside the checklist's GET, refresh and skip, a
 * single in-flight recompute (up to a minute, mostly waiting on integrations)
 * occupied the same pool those one-second interactions needed — and on the
 * hobby plan's concurrency, every save and page load on Period Close queued
 * behind it. Diagnosed live 2026-09-13: a settings read hanging 45s while a
 * preview ran. The split means the everyday function never waits on the
 * heavyweight one.
 *
 * Both actions stay gated and shaped exactly as they were in ../route.ts;
 * see that file for the action-by-action rationale.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP, getSessionUser } from "@/lib/auth";
import { monthEnd } from "@/lib/finance/manualEntries";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { todayLocalDate } from "@/lib/utils/datetime";
import { closePeriod } from "@/lib/finance/balances/periodClose";
import { snapshotPeriod } from "@/lib/finance/balances/snapshot";

export const dynamic = "force-dynamic";
/** Closing/previewing runs a full recalculation, including live reads against Ramp, Plaid and Square. */
export const maxDuration = 60;

interface Body {
  action?: string;
  periodEnd?: string;
  reason?: string;
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as Body;

    if (body.action !== "preview" && body.action !== "close-period") {
      return NextResponse.json({ error: 'action must be "preview" or "close-period"' }, { status: 400 });
    }
    if (!body.periodEnd || body.periodEnd !== monthEnd(body.periodEnd)) {
      return NextResponse.json({ error: "periodEnd is required and must be a month end" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();

    if (body.action === "preview") {
      const snapshot = await snapshotPeriod(supabase, body.periodEnd, { dryRun: true });
      return NextResponse.json({
        ok: true,
        wouldCloseAtCents: snapshot.balancingDifferenceCents,
        errors: snapshot.errors,
        excluded: snapshot.excluded,
      });
    }

    // close-period: attributed, so it needs a real signed-in user — an
    // unattributed close is the thing this workflow replaced.
    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json({ error: "Sign in again before closing a month." }, { status: 401 });
    }

    const result = await closePeriod(supabase, {
      periodEnd: body.periodEnd,
      actorId: session.user.id,
      todayIso: todayLocalDate(),
      reason: typeof body.reason === "string" ? body.reason : null,
    });
    // 409, not 400: the request was well formed and the answer is about the
    // state of the books. The blockers are full sentences meant to be shown.
    return result.ok
      ? NextResponse.json({ ok: true, close: result.state, snapshot: result.snapshot })
      : NextResponse.json({ error: result.blockers.join(" "), blockers: result.blockers }, { status: 409 });
  } catch (err) {
    return apiError(err);
  }
}
