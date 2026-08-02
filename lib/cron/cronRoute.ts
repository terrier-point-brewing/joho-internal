/**
 * The scheduled side of a job: one handler, shared by all nine cron routes.
 *
 * Each route file is now its own name plus, where it needs one, its own time
 * limit — which has to be a static export per file, so it cannot live here.
 * Everything else about answering a scheduled request is the same for every
 * job, and was copied nine times before this.
 *
 * CRON_SECRET stays the gate on this path and only this path. The button in
 * Settings goes through app/api/cron/run/[job], which is gated on a person's
 * permissions instead — a browser has no business holding this secret.
 */
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCronJob } from "@/lib/cron/runCronJob";
import { getCronJob } from "@/lib/cron/jobs";
import { apiError } from "@/lib/utils/api";

export function createCronRouteHandler(job: string) {
  return async function GET(req: NextRequest): Promise<Response> {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const definition = getCronJob(job);
    if (!definition) return apiError(`no job is registered under the name ${job}`, 500);

    const outcome = await runCronJob(job, () => definition.run(createSupabaseAdminClient()), {
      trigger: "schedule",
    });

    if (outcome.ok) return NextResponse.json(outcome.detail);
    // 409 for a refused run: the schedule fired while a run was already going,
    // which is a conflict rather than a failure. Vercel retries nothing either
    // way, and the run in progress is doing the work.
    if (outcome.busy) return NextResponse.json({ error: outcome.error, busy: true }, { status: 409 });
    return apiError(outcome.error);
  };
}
