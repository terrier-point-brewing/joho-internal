/**
 * Scheduled entry point for the cold-storage → Square inventory push. What it
 * does lives in lib/cron/jobs/squareInventoryPush.ts, so the "Run now" button
 * runs the same thing rather than a second copy of it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";

export const GET = createCronRouteHandler("square-inventory-push");
