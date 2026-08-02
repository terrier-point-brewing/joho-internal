/**
 * Scheduled entry point for the daily bank-balance capture. What it does — and
 * why it runs at 02:00 UTC — lives in lib/cron/jobs/balanceCapture.ts, so that
 * the "Run now" button runs the same thing rather than a second copy of it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";
/** A bank read can take ~30s; several connections in series need the headroom. */
export const maxDuration = 300;

export const GET = createCronRouteHandler("balance-capture");
