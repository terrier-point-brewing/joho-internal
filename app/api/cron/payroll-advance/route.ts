/**
 * Scheduled entry point for rolling the pay period forward. What it does lives
 * in lib/cron/jobs/payrollAdvance.ts, so that the "Run now" button runs the same
 * thing rather than a second copy of it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";

export const GET = createCronRouteHandler("payroll-advance");
