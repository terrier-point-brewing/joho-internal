/**
 * Scheduled entry point for the weekly gap scan. What it does, and why it
 * compares counts instead of widening the nightly window, lives in
 * lib/cron/jobs/financeGapScan.ts, so that the "Run now" button runs the same
 * thing rather than a second copy of it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";
/** A 120-day comparison plus up to 14 days of healing is not a quick request. */
export const maxDuration = 300;

export const GET = createCronRouteHandler("finance-gap-scan");
