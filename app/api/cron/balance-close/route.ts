/**
 * Scheduled entry point for the month-end balance close. What it does, in what
 * order and why, lives in lib/cron/jobs/balanceClose.ts, so that the "Run now"
 * button runs the same thing rather than a second copy of it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";

export const GET = createCronRouteHandler("balance-close");
