import { describe, it, expect, vi } from "vitest";
import "./methods";
import { planCaptures, captureDailyBalances, type BalanceReader } from "./dailyCapture";
import type { DeclaredSource } from "./snapshot";
import type { ConnectionWithSecrets } from "./connections";

type AdminClient = Parameters<typeof captureDailyBalances>[0];

function source(over: Partial<DeclaredSource> = {}): DeclaredSource {
  return {
    coaId: "coa-1020",
    providerKey: "plaidBankBalance",
    config: { connectionId: "conn-1" },
    ...over,
  };
}

describe("planCaptures", () => {
  it("picks the accounts whose method reads the given integration", () => {
    const targets = planCaptures(
      [
        source(),
        source({ coaId: "coa-2310", providerKey: "undistributedTips", config: {} }),
        source({ coaId: "coa-3300", providerKey: "retainedEarnings", config: {} }),
      ],
      "plaid",
    );
    expect(targets).toEqual([{ connectionId: "conn-1", coaIds: ["coa-1020"] }]);
  });

  it("ignores another integration's accounts", () => {
    // Ramp and Square land on separate branches; each run must read only its
    // own connections or the first merged one starts reading the others'.
    const ramp = planCaptures([source()], "ramp");
    expect(ramp).toEqual([]);
  });

  it("skips a source that has no bank linked yet", () => {
    expect(planCaptures([source({ config: {} })], "plaid")).toEqual([]);
    expect(planCaptures([source({ config: { connectionId: "" } })], "plaid")).toEqual([]);
    expect(planCaptures([source({ config: { connectionId: 42 } })], "plaid")).toEqual([]);
  });

  it("reads one connection once even when it feeds several accounts", () => {
    const targets = planCaptures([source(), source({ coaId: "coa-1021" })], "plaid");
    expect(targets).toEqual([{ connectionId: "conn-1", coaIds: ["coa-1020", "coa-1021"] }]);
  });

  it("does not repeat an account declared twice against the same connection", () => {
    expect(planCaptures([source(), source()], "plaid")).toEqual([
      { connectionId: "conn-1", coaIds: ["coa-1020"] },
    ]);
  });

  it("keeps two connections apart", () => {
    const targets = planCaptures([source(), source({ coaId: "coa-1040", config: { connectionId: "conn-2" } })], "plaid");
    expect(targets).toHaveLength(2);
  });

  it("ignores a bare provider key, which never carries a connection", () => {
    expect(planCaptures([source({ providerKey: "plaidBalance" })], "plaid")).toEqual([]);
    expect(planCaptures([source({ providerKey: "somethingUnregistered" })], "plaid")).toEqual([]);
  });
});

// ── captureDailyBalances ─────────────────────────────────────────────────────

interface Recorded {
  daily: Record<string, unknown>[];
  syncPatches: Record<string, unknown>[];
}

/**
 * Stubs the three tables captureDailyBalances touches and records the writes.
 * `connections` is keyed by id; a missing id models a deleted connection.
 */
function stubClient(
  declared: DeclaredSource[],
  connections: Record<string, Partial<ConnectionWithSecrets> | undefined>,
): { client: AdminClient; recorded: Recorded } {
  const recorded: Recorded = { daily: [], syncPatches: [] };

  const client = {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      let lookupId = "";

      Object.assign(builder, {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          if (col === "id") lookupId = String(val);
          return builder;
        },
        maybeSingle: async () => {
          const c = connections[lookupId];
          if (!c) return { data: null, error: null };
          return {
            data: {
              id: lookupId,
              provider: "plaid",
              label: c.label ?? "Chase · Operating",
              external_id: c.externalId ?? "plaid-account-1",
              config: {},
              status: c.status ?? "active",
              last_synced_at: null,
              last_error: null,
              credentials: c.credentials ?? { access_token: "access-live" },
            },
            error: null,
          };
        },
        upsert: async (row: Record<string, unknown>) => {
          recorded.daily.push(row);
          return { error: null };
        },
        update: (row: Record<string, unknown>) => {
          recorded.syncPatches.push(row);
          return builder;
        },
        // fetchDeclaredSources awaits the builder directly.
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: declared.map((d) => ({
              chart_of_accounts_id: d.coaId,
              provider_key: d.providerKey,
              config: d.config,
            })),
            error: null,
          }),
      });

      if (table === "integration_connections") delete builder.then;
      return builder;
    },
  };

  return { client: client as unknown as AdminClient, recorded };
}

const reads = (cents: number | null): BalanceReader => async () => cents;

describe("captureDailyBalances", () => {
  it("records the balance under the date it represents", async () => {
    const { client, recorded } = stubClient([source()], { "conn-1": {} });

    const outcome = await captureDailyBalances(client, {
      provider: "plaid",
      asOfDate: "2026-08-31",
      read: reads(4_812_355),
    });

    expect(outcome).toMatchObject({ captured: 1, failed: 0, considered: 1 });
    expect(recorded.daily).toHaveLength(1);
    expect(recorded.daily[0]).toMatchObject({
      chart_of_accounts_id: "coa-1020",
      as_of_date: "2026-08-31",
      balance_cents: 4_812_355,
      connection_id: "conn-1",
    });
  });

  it("marks the connection healthy after a good read", async () => {
    const { client, recorded } = stubClient([source()], { "conn-1": {} });
    await captureDailyBalances(client, { provider: "plaid", asOfDate: "2026-08-31", read: reads(1) });
    expect(recorded.syncPatches[0]).toMatchObject({ status: "active", last_error: null });
  });

  it("passes the stored credential to the reader without it reaching a write", async () => {
    const { client, recorded } = stubClient([source()], { "conn-1": { credentials: { access_token: "live-token" } } });
    let seen: unknown = null;
    await captureDailyBalances(client, {
      provider: "plaid",
      asOfDate: "2026-08-31",
      read: async (c) => {
        seen = c.credentials.access_token;
        return 100;
      },
    });
    expect(seen).toBe("live-token");
    expect(JSON.stringify(recorded)).not.toContain("live-token");
  });

  it("treats no-balance-returned as a failure, never as a zero balance", async () => {
    // A false 0 on a bank account reads as a real, reconciled figure.
    const { client, recorded } = stubClient([source()], { "conn-1": {} });

    const outcome = await captureDailyBalances(client, {
      provider: "plaid",
      asOfDate: "2026-08-31",
      read: reads(null),
    });

    expect(outcome).toMatchObject({ captured: 0, failed: 1 });
    expect(recorded.daily).toEqual([]);
    expect(recorded.syncPatches[0]).toMatchObject({ status: "error" });
  });

  it("stores a genuine zero balance", async () => {
    const { client, recorded } = stubClient([source()], { "conn-1": {} });
    const outcome = await captureDailyBalances(client, {
      provider: "plaid",
      asOfDate: "2026-08-31",
      read: reads(0),
    });
    expect(outcome.captured).toBe(1);
    expect(recorded.daily[0]).toMatchObject({ balance_cents: 0 });
  });

  it("isolates a failing bank so the others still get captured", async () => {
    // A missed day cannot be recovered tomorrow, so one outage must not cost
    // every other account its capture.
    const { client, recorded } = stubClient(
      [source(), source({ coaId: "coa-1040", config: { connectionId: "conn-2" } })],
      { "conn-1": {}, "conn-2": {} },
    );

    let call = 0;
    const outcome = await captureDailyBalances(client, {
      provider: "plaid",
      asOfDate: "2026-08-31",
      read: async () => {
        call++;
        if (call === 1) throw new Error("INSTITUTION_DOWN");
        return 500;
      },
    });

    expect(outcome).toMatchObject({ captured: 1, failed: 1, considered: 2 });
    expect(outcome.errors[0]).toMatch(/conn-1.*INSTITUTION_DOWN/);
    expect(recorded.daily).toHaveLength(1);
  });

  it("flags an expired credential as needing a relink rather than a retry", async () => {
    const { client, recorded } = stubClient([source()], { "conn-1": {} });
    await captureDailyBalances(client, {
      provider: "plaid",
      asOfDate: "2026-08-31",
      read: async () => {
        throw Object.assign(new Error("login required"), { needsReauth: true });
      },
    });
    expect(recorded.syncPatches[0]).toMatchObject({ status: "needs_reauth" });
  });

  it("records an ordinary outage as an error, not as a relink prompt", async () => {
    const { client, recorded } = stubClient([source()], { "conn-1": {} });
    await captureDailyBalances(client, {
      provider: "plaid",
      asOfDate: "2026-08-31",
      read: async () => {
        throw new Error("502 from the bank");
      },
    });
    expect(recorded.syncPatches[0]).toMatchObject({ status: "error" });
  });

  it("reports a source pointing at a deleted connection rather than skipping it quietly", async () => {
    const { client } = stubClient([source()], {});
    const outcome = await captureDailyBalances(client, {
      provider: "plaid",
      asOfDate: "2026-08-31",
      read: reads(1),
    });
    expect(outcome.failed).toBe(1);
    expect(outcome.errors[0]).toMatch(/no longer exists/);
  });

  it("leaves a disabled connection alone", async () => {
    const { client, recorded } = stubClient([source()], { "conn-1": { status: "disabled" } });
    const read = vi.fn(reads(1));
    const outcome = await captureDailyBalances(client, { provider: "plaid", asOfDate: "2026-08-31", read });
    expect(read).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ captured: 0, failed: 0 });
    expect(recorded.syncPatches).toEqual([]);
  });

  it("writes one row per account when a connection feeds several", async () => {
    const { client, recorded } = stubClient([source(), source({ coaId: "coa-1021" })], { "conn-1": {} });
    const read = vi.fn(reads(777));
    const outcome = await captureDailyBalances(client, { provider: "plaid", asOfDate: "2026-08-31", read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(outcome.captured).toBe(2);
    expect(recorded.daily.map((r) => r.chart_of_accounts_id)).toEqual(["coa-1020", "coa-1021"]);
  });

  it("does nothing at all when no account is linked", async () => {
    const { client, recorded } = stubClient([source({ config: {} })], { "conn-1": {} });
    const outcome = await captureDailyBalances(client, { provider: "plaid", asOfDate: "2026-08-31", read: reads(1) });
    expect(outcome).toMatchObject({ captured: 0, failed: 0, considered: 0 });
    expect(recorded.daily).toEqual([]);
  });
});
