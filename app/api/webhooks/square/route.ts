import { NextRequest, NextResponse, after } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runTaproomConsumptionSync } from "@/lib/production/taproomConsumptionSync";
import { verifySquareSignature, isReconcilableSquareEvent } from "@/lib/square/webhook";

export const dynamic = "force-dynamic";
// Give the background reconcile (Square API round-trips) room to finish after we
// respond; Vercel caps this to the plan's max.
export const maxDuration = 60;

/**
 * Square webhook → near-real-time taproom-consumption reconcile.
 *
 * When a bartender rings a Draft Restock (or any order changes), Square POSTs an
 * order event here. We verify the HMAC signature (the only auth — this endpoint
 * is public), then run the SAME idempotent sync the daily cron uses over a short
 * window, so the swap shipment + recount + shrinkage land within seconds instead
 * of by the next 07:00 cron. The cron stays as a safety net for missed deliveries;
 * idempotency (per source_ref) makes overlapping webhook + cron runs harmless.
 *
 * Env: SQUARE_WEBHOOK_SIGNATURE_KEY (dashboard signature key) and
 * SQUARE_WEBHOOK_URL (the exact notification URL configured in Square — it is
 * part of the signed payload, so it must match character-for-character).
 */
const WINDOW_DAYS = 1;

export async function POST(req: NextRequest) {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.SQUARE_WEBHOOK_URL;
  if (!signatureKey || !notificationUrl) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Raw body is required for signature verification — read it before parsing.
  const rawBody = await req.text();
  const valid = verifySquareSignature({
    signatureKey,
    notificationUrl,
    rawBody,
    signatureHeader: req.headers.get("x-square-hmacsha256-signature"),
  });
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let event: { type?: string } = {};
  try {
    event = JSON.parse(rawBody) as { type?: string };
  } catch {
    // A verified-but-unparseable body shouldn't happen; ack so Square stops retrying.
    return NextResponse.json({ ignored: true, reason: "unparseable" });
  }

  // Only order events trigger a reconcile; ack everything else with 200 so Square
  // doesn't retry non-actionable deliveries.
  if (!isReconcilableSquareEvent(event.type)) {
    return NextResponse.json({ ignored: true, type: event.type ?? null });
  }

  // Reconcile in the background so Square gets an immediate 200. The full sync
  // makes several Square round-trips and would otherwise blow the gateway timeout
  // (504) — and Square would then retry a delivery we already accepted. It's
  // idempotent per source_ref and the daily cron is the safety net, so a dropped
  // or partial background run self-heals on the next trigger.
  after(async () => {
    try {
      const supabase = createSupabaseAdminClient();
      const result = await runTaproomConsumptionSync(supabase, { days: WINDOW_DAYS });
      console.log("[square-webhook] reconcile", {
        type: event.type,
        recordedUnits: result.recordedUnits,
        recountsApplied: result.recountsApplied,
        discrepancies: result.discrepancies.length,
      });
    } catch (e) {
      // Logged, not returned — Square already has its 200; the cron reconciles too.
      console.error("[square-webhook] reconcile failed", e);
    }
  });

  return NextResponse.json({ ok: true, queued: true, type: event.type });
}
