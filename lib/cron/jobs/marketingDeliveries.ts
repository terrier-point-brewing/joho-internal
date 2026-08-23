/**
 * Mounts the marketing publishing worker as a scheduled job.
 *
 * This file is the seam. It is the ONE module outside marketing that reaches
 * into it, and it exists so that `lib/cron/jobs/index.ts` — which every cron
 * route imports — never has to. `scripts/check-marketing-boundary.mjs` names
 * this exact file and this exact import as its second exception; see the
 * comment on `RULE_1_EXCEPTIONS` there for why mounting is not depending.
 *
 * ── The lease is not the safety mechanism ───────────────────────────────────
 * `runCronJob` claims an advisory lease under `cron:marketing-deliveries`
 * before calling this, which stops two whole scheduled runs overlapping. That
 * is a COARSER guarantee than what publishing needs, and it is not what makes
 * this job safe. The lease says nothing about a scheduled run racing the
 * "Run now" button, and nothing about an invocation retried by the platform.
 *
 * What makes it safe is the row-level claim inside `runMarketingDeliveries` —
 * one `update … where status = 'scheduled' … returning *`, which under READ
 * COMMITTED cannot hand the same row to two callers. Read the header of
 * `lib/marketing/worker.ts` before changing anything here. The lease is a
 * courtesy; the claim is the contract.
 *
 * ── Re-run safety ───────────────────────────────────────────────────────────
 * Running this again does not disturb work a person did by hand. It only ever
 * touches rows sitting in `scheduled`, so a delivery someone has failed,
 * skipped, published or paused is invisible to it, and a `failed` one stays
 * failed until a person presses Retry. See `lib/cron/reRunSafety.test.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { runMarketingDeliveries } from "@/lib/marketing/worker";

export async function runMarketingDeliveriesJob(supabase: SupabaseClient) {
  return runMarketingDeliveries(supabase);
}
