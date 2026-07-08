import { NextRequest, NextResponse, after } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getRampTransactions } from "@/lib/ramp";
import { syncRampExpenses } from "@/lib/finance/rampExpenses";
import { verifyRampSignature, isReconcilableRampEvent } from "@/lib/ramp/webhook";

export const dynamic = "force-dynamic";
// Give the background re-sync (Ramp + Supabase round-trips) room to finish after
// we respond; Vercel caps this to the plan's max. Ramp itself times out a
// delivery after 10s, which we already beat by acking before the sync runs.
export const maxDuration = 60;

/**
 * Ramp webhook → near-real-time expense re-sync.
 *
 * When card spend posts or changes, Ramp POSTs a `transactions.*` event here. We
 * verify the `X-Ramp-Signature` HMAC (the only auth — this endpoint is public),
 * then run the SAME idempotent sync the daily cron uses over a short trailing
 * window, so the expense (and later state changes like authorized → cleared)
 * lands within seconds instead of by the next 06:30 cron. The cron stays as a
 * safety net for missed deliveries; idempotency (upsert keyed
 * source,source_transaction_id) makes overlapping webhook + cron runs harmless,
 * and the trailing-window re-derive absorbs Ramp's out-of-order deliveries.
 *
 * Env: RAMP_WEBHOOK_SECRET — the `secret` field returned when the subscription
 * is created via POST /developer/v1/webhooks.
 */
const LOOKBACK_DAYS = 2;

interface RampWebhookEvent {
  id?: string;
  type?: string;
  challenge?: string;
  object?: { id?: string };
}

export async function POST(req: NextRequest) {
  // Raw body is required for signature verification — read it before parsing.
  const rawBody = await req.text();

  let event: RampWebhookEvent = {};
  try {
    event = JSON.parse(rawBody) as RampWebhookEvent;
  } catch {
    return NextResponse.json({ ignored: true, reason: "unparseable" });
  }
  const type = event.type;

  // One-time endpoint-verification handshake. During subscription setup Ramp
  // POSTs a `webhooks.verification` challenge here; the subscription is confirmed
  // by a SEPARATE authenticated call back to Ramp:
  //   POST /developer/v1/webhooks/{webhook_id}/verify  { "challenge": "<value>" }
  // It needs neither the signing secret nor the signature, and it arrives right
  // after creation — before RAMP_WEBHOOK_SECRET has been configured — so it MUST
  // be handled before the secret/signature gates below, otherwise the challenge
  // 500s and never gets logged, stranding setup. We ack 200 (Ramp just needs
  // reachability) and log the challenge so the /verify call can be completed.
  if (type === "webhooks.verification") {
    console.log("[ramp-webhook] verification challenge received", {
      challenge: event.challenge ?? null,
      raw: rawBody,
    });
    return NextResponse.json({ ok: true });
  }

  const secret = process.env.RAMP_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Every business event is signed — verify before acting on any of its data.
  const valid = verifyRampSignature({
    secret,
    rawBody,
    signatureHeader: req.headers.get("x-ramp-signature"),
  });
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  // Only transaction events trigger a re-sync; ack everything else with 200 so
  // Ramp doesn't retry non-actionable deliveries.
  if (!isReconcilableRampEvent(type)) {
    return NextResponse.json({ ignored: true, type: type ?? null });
  }

  // Re-sync in the background so Ramp gets an immediate 200 (it times out a
  // delivery after 10s and would then retry one we already accepted). The sync
  // is idempotent per source_transaction_id and the daily cron is the safety
  // net, so a dropped or partial background run self-heals on the next trigger.
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
        eventId: event.id,
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
