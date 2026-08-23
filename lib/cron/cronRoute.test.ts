/**
 * The gate on the scheduled path.
 *
 * `CRON_SECRET` is the only thing standing between the open internet and a job
 * that posts publicly — `marketing-deliveries` publishes to every connected
 * channel with an entry that is due, and a post cannot be taken back. So the
 * two ways of arriving without the secret, missing and wrong, are both pinned
 * here, and both are asserted to stop BEFORE any job runs rather than merely to
 * answer 401 afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const run = vi.fn(async () => ({ published: 1 }));

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/cron/jobs", () => ({
  getCronJob: (job: string) => (job === "marketing-deliveries" ? { job, run } : undefined),
}));
vi.mock("@/lib/cron/runCronJob", () => ({
  runCronJob: async (_job: string, work: () => Promise<unknown>) => ({ ok: true, detail: await work() }),
}));

import { createCronRouteHandler } from "./cronRoute";

const GET = createCronRouteHandler("marketing-deliveries");

const request = (headers: Record<string, string> = {}) =>
  new NextRequest("https://internal.example.com/api/cron/marketing-deliveries", { headers });

beforeEach(() => {
  run.mockClear();
  vi.stubEnv("CRON_SECRET", "the-real-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the scheduled path", () => {
  it("rejects a request with no Authorization header at all", async () => {
    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a request carrying the wrong secret", async () => {
    const res = await GET(request({ authorization: "Bearer not-the-secret" }));

    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects the right secret sent the wrong way", async () => {
    // A bare token with no scheme, which is the shape a hand-rolled caller
    // reaches for first.
    const res = await GET(request({ authorization: "the-real-secret" }));

    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the job for the schedule's own secret", async () => {
    const res = await GET(request({ authorization: "Bearer the-real-secret" }));

    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual({ published: 1 });
  });
});
