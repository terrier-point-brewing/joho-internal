/**
 * The shared runner, which is now the only way a job runs.
 *
 * Two properties matter enough to pin down. A job must never run twice at once,
 * because a manual run can land on top of a scheduled one and several of these
 * jobs read-then-write. And logging must keep working before the attribution
 * migration is applied, since it is deliberately unapplied and a lost run
 * record is a hole in the only history anyone can see.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn();
const rpc = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: () => ({ insert: (row: unknown) => insert(row) }),
    rpc: (fn: string, args: unknown) => rpc(fn, args),
  }),
}));

import { runCronJob, BUSY_MESSAGE } from "./runCronJob";

/** The lock is free unless a test says otherwise. */
function lockIsFree() {
  rpc.mockImplementation(async (fn: string) =>
    fn === "try_acquire_sync_lock" ? { data: true, error: null } : { error: null },
  );
}

beforeEach(() => {
  insert.mockReset();
  rpc.mockReset();
  insert.mockResolvedValue({ error: null });
  lockIsFree();
});

describe("the run lock", () => {
  it("claims the lock under the job's own name before doing anything", async () => {
    const work = vi.fn().mockResolvedValue({ ok: 1 });
    await runCronJob("finance-sync", work);

    expect(rpc).toHaveBeenCalledWith("try_acquire_sync_lock", expect.objectContaining({ p_job: "cron:finance-sync" }));
    expect(work).toHaveBeenCalled();
  });

  it("does no work at all when another run already holds it", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "try_acquire_sync_lock" ? { data: false, error: null } : { error: null },
    );
    const work = vi.fn();

    const outcome = await runCronJob("finance-sync", work);

    expect(work).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, busy: true, error: BUSY_MESSAGE });
  });

  it("says so in a sentence, because a person reads it", async () => {
    // Whoever clicked deserves to know the click was heard and refused, not to
    // watch a button do nothing.
    expect(BUSY_MESSAGE).toMatch(/already running/);
    expect(BUSY_MESSAGE).not.toMatch(/[_{}]|sync_lock/);
  });

  it("records nothing for a refused run, which is not a run", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "try_acquire_sync_lock" ? { data: false, error: null } : { error: null },
    );

    await runCronJob("finance-sync", vi.fn());

    expect(insert).not.toHaveBeenCalled();
  });

  it("releases the lock after the work succeeds", async () => {
    await runCronJob("tax-tasks", vi.fn().mockResolvedValue(null));

    expect(rpc).toHaveBeenCalledWith("release_sync_lock", { p_job: "cron:tax-tasks" });
  });

  it("releases the lock after the work throws, so one failure does not wedge the job", async () => {
    await runCronJob("tax-tasks", vi.fn().mockRejectedValue(new Error("Square is down")));

    expect(rpc).toHaveBeenCalledWith("release_sync_lock", { p_job: "cron:tax-tasks" });
  });

  it("does not release a lock it never held", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "try_acquire_sync_lock" ? { data: false, error: null } : { error: null },
    );

    await runCronJob("tax-tasks", vi.fn());

    expect(rpc).not.toHaveBeenCalledWith("release_sync_lock", expect.anything());
  });

  it("fails the run rather than running unguarded when the lock itself is broken", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "try_acquire_sync_lock" ? { data: null, error: { message: "no such function" } } : { error: null },
    );
    const work = vi.fn();

    const outcome = await runCronJob("finance-sync", work);

    expect(work).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, busy: false });
  });
});

describe("what the history records", () => {
  it("marks a scheduled run as scheduled, without being told", async () => {
    await runCronJob("finance-sync", vi.fn().mockResolvedValue({ orders: 3 }));

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      job: "finance-sync",
      status: "success",
      triggered_by: "schedule",
      triggered_by_user_id: null,
    }));
  });

  it("names the person behind a run somebody started", async () => {
    await runCronJob("finance-sync", vi.fn().mockResolvedValue(null), {
      trigger: "manual",
      actorId: "user-7",
    });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      triggered_by: "manual",
      triggered_by_user_id: "user-7",
    }));
  });

  it("still records the run when the attribution columns do not exist yet", async () => {
    // The migration is authored and unapplied on purpose. Until it is applied,
    // the database rejects the first insert; losing the record of who started a
    // run is a far smaller loss than losing the record that it ran.
    insert
      .mockResolvedValueOnce({ error: { message: "column cron_runs.triggered_by does not exist" } })
      .mockResolvedValueOnce({ error: null });

    await runCronJob("finance-sync", vi.fn().mockResolvedValue({ orders: 3 }));

    expect(insert).toHaveBeenCalledTimes(2);
    const retried = insert.mock.calls[1][0] as Record<string, unknown>;
    expect(retried).toMatchObject({ job: "finance-sync", status: "success" });
    expect(retried).not.toHaveProperty("triggered_by");
  });

  it("records a failure with its message and hands the message back", async () => {
    const outcome = await runCronJob("finance-sync", vi.fn().mockRejectedValue(new Error("Square is down")));

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ status: "error", error: "Square is down" }));
    expect(outcome).toEqual({ ok: false, busy: false, error: "Square is down" });
  });

  it("never lets a logging failure fail the job", async () => {
    insert.mockRejectedValue(new Error("the log table is unreachable"));

    const outcome = await runCronJob("finance-sync", vi.fn().mockResolvedValue({ orders: 3 }));

    expect(outcome).toEqual({ ok: true, detail: { orders: 3 } });
  });
});
