/**
 * "Run now": the manual side of a scheduled job.
 *
 * Gated on the finance transactions permission, never on CRON_SECRET. That
 * secret is the schedule's proof that Vercel called it; a browser holding it
 * would turn every job into an unauthenticated endpoint for anyone who read a
 * network tab. Permissions are how a person is checked.
 *
 * POST, because this is not a lookup — even the jobs that usually change
 * nothing may write, and a GET would be fetched by a link preview or a retry.
 *
 * The job itself comes from lib/cron/jobs, the same definition the scheduled
 * route uses, and goes through the same runCronJob — so a run started here is
 * locked, timed and recorded exactly like a nightly one, and shows up in the
 * same history with its own attribution.
 */
import { NextResponse, after } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCronJob } from "@/lib/cron/runCronJob";
import { getCronJob } from "@/lib/cron/jobs";

export const dynamic = "force-dynamic";
/**
 * The ceiling for a "wait" job, and for how long a "start" job may carry on
 * after the answer has gone out. It is the platform's limit, not a promise: a
 * job that outlives it stops where it stopped, which for every job here means
 * the next run carries on rather than starting over.
 */
export const maxDuration = 300;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ job: string }> },
): Promise<Response> {
  let session;
  try {
    session = await requirePermission(CAP.financeTransactionsManage);
  } catch (res) {
    return res as Response;
  }

  const { job } = await params;
  const definition = getCronJob(job);
  if (!definition) {
    return NextResponse.json({ error: "There is no job by that name." }, { status: 404 });
  }

  const work = () => definition.run(createSupabaseAdminClient());
  const options = { trigger: "manual" as const, actorId: session.user.id };

  if (definition.manualRun === "start") {
    // Answered before the work finishes, because these jobs page against a bank
    // or against Square and can run for minutes. `after` keeps the function
    // alive past the response; the lock still means a second click lands on a
    // run in progress and is turned away, it just cannot be told so here.
    after(async () => {
      const outcome = await runCronJob(job, work, options);
      if (!outcome.ok) console.error("[cron] manual run did not succeed", { job, error: outcome.error });
    });
    return NextResponse.json({
      started: true,
      job,
      message: "The job has started. Its result will appear in the run history below when it finishes.",
    });
  }

  const outcome = await runCronJob(job, work, options);
  if (outcome.ok) return NextResponse.json({ started: true, job, detail: outcome.detail });
  // 409 rather than 500 when a run is already going: nothing failed, and the
  // message is something the person can act on.
  if (outcome.busy) return NextResponse.json({ error: outcome.error }, { status: 409 });
  return NextResponse.json({ error: outcome.error }, { status: 500 });
}
