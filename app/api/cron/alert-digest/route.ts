/**
 * Scheduled entry point for the morning alert digest. The work lives in
 * lib/cron/jobs/alertDigest.ts, so the "Run now" button runs the same thing.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";

export const GET = createCronRouteHandler("alert-digest");
