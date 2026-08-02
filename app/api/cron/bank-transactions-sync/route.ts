/**
 * Scheduled entry point for the Plaid transaction import. What it does — and
 * why it runs at 03:00 UTC — lives in lib/cron/jobs/bankTransactionsSync.ts, so
 * that the "Run now" button runs the same thing rather than a second copy of it.
 */
import { createCronRouteHandler } from "@/lib/cron/cronRoute";

export const dynamic = "force-dynamic";
/** A long first sync pages against the bank; give it the same headroom as the balance capture. */
export const maxDuration = 300;

export const GET = createCronRouteHandler("bank-transactions-sync");
