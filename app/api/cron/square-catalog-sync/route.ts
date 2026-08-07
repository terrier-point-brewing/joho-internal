/**
 * Scheduled entry point for the Square catalog mirror refresh. What it does
 * lives in lib/cron/jobs/squareCatalogSync.ts, so the "Run now" button runs the
 * same thing rather than a second copy of it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";

export const GET = createCronRouteHandler("square-catalog-sync");
