/**
 * Scheduled entry point for the forecast snapshot. What it does lives in
 * lib/cron/jobs/forecastSnapshot.ts, so that the "Run now" button runs the same
 * thing rather than a second copy of it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";
/** Builds the P&L and the cash-flow statement, each a full year of reads. */
export const maxDuration = 300;

export const GET = createCronRouteHandler("forecast-snapshot");
