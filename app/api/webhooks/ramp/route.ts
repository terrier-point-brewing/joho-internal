import { NextRequest, NextResponse, after } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getRampTransactions } from "@/lib/ramp";
import { syncRampExpenses } from "@/lib/finance/rampExpenses";
import { verifyRampSignature, isReconcilableRampEvent } from "@/lib/ramp/webhook";

export const dynamic = "force-dynamic";
// Give the background re-sync (Ramp + Supabase round-trips) room to finish after
// we respond; Vercel caps this to the plan's max.
export const maxDuration = 60;

/**
 * Ramp webhook → near-real-time expense re-sync.
 *
 * When card spend posts or changes, Ramp POSTs a transaction event here. We
 * verify the Svix signature (the only auth — this endpoint is public), then run
 * the SAME idempotent sync the daily cron uses over a short trailing window, so
 * the expense (and later state changes like PENDING → CLEARED) lands within
 * seconds instead of by the next 06:30 cron. The cron stays as a safety net for
 * missed deliveries; idempotency (upsert keyed source,source_transaction_id)
 * makes overlapping webhook + cron runs harmless.
 *
 * Env: RAMP_WEBHOOK_SECRET — the Svix signing secret (`whsec_...`) from the
 * Ramp webhook configuration.
 */
const LOOKBACK_DAYS = 2;

export async function POST(req: NextRequest) {
  const secret = process.env.RAMP_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Raw body is required for signature verification — read it before parsing.
  const rawBody = await req.text();
  const valid = verifyRampSignature({
    secret,
    svixId: req.headers.get("svix-id"),
    svixTimestamp: req.headers.get("svix-timestamp"),
    rawBody,
    signatureHeader: req.headers.get("svix-signature"),
  });
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let event: { event_type?: string; type?: string } = {};
  try {
    event = JSON.parse(rawBody) as { event_type?: string; type?: string };
  } catch {
    // A verified-but-unparseable body shouldn't happen; ack so Ramp stops retrying.
    return NextResponse.json({ ignored: true, reason: "unparseable" });
  }
  const type = event.event_type ?? event.type;

  // Only transaction events trigger a re-sync; ack everything else with 200 so
  // Ramp doesn't retry non-actionable deliveries.
  if (!isReconcilableRampEvent(type)) {
    return NextResponse.json({ ignored: true, type: type ?? null });
  }

  // Re-sync in the background so Ramp gets an immediate 200. The sync makes Ramp
  // + Supabase round-trips and would otherwise risk the gateway timeout (504) —
  // and Ramp would then retry a delivery we already accepted. It's idempotent per
  // source_transaction_id and the daily cron is the safety net, so a dropped or
  // partial background run self-heals on the next trigger.
  after(async () => {
    try {
      const to = new Date();
      const from = new Date(to);
      from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);

      const txns = await getRampTransactions(fromStr, toStr);
      const supabase = createSupabaseAdminClient();
      const result = await syncRampExpenses(supabase, txns);
      console.log("[ramp-webhook] reconcile", {
        type,
        imported: result.imported,
        mapped: result.mapped,
        unmapped: result.unmapped,
        window: { from: fromStr, to: toStr },
      });
    } catch (e) {
      // Logged, not returned — Ramp already has its 200; the cron reconciles too.
      console.error("[ramp-webhook] reconcile failed", e);
    }
  });

  return NextResponse.json({ ok: true, queued: true, type });
}
