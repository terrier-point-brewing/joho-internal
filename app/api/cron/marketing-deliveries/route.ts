/**
 * Scheduled entry point for the marketing publishing worker. What it does lives
 * in lib/cron/jobs/marketingDeliveries.ts, so that the "Run now" button runs the
 * same thing rather than a second copy of it.
 *
 * CRON_SECRET gates this path and only this path — the handler 401s on a
 * missing or wrong Authorization header before it reaches any job. Nothing a
 * browser holds can reach it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";

export const GET = createCronRouteHandler("marketing-deliveries");
