/**
 * Scheduled entry point for the month-end balance close. What it does, in what
 * order and why, lives in lib/cron/jobs/balanceClose.ts, so that the "Run now"
 * button runs the same thing rather than a second copy of it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";
/** One full recalculation per open month, each with live reads against Ramp, Plaid and Square. */
export const maxDuration = 300;

export const GET = createCronRouteHandler("balance-close");
