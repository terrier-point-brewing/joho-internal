/**
 * Connected accounts, and the column that must never leave the server.
 *
 * Two properties carry this file. The first is that re-connecting a channel
 * MOVES the existing row rather than adding a second one — two rows for one
 * channel means the worker can pick the stale one, and publish with a dead
 * token or, worse, the wrong account. The second is that `credentials` is
 * written and never read back: every assertion here serialises the whole
 * response and looks for the secret in it, which is the same check a person
 * would do by hand and the one that keeps working when this code is edited.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ACCOUNT_SAFE_COLUMNS, disconnectAccount, upsertConnectedAccount } from "./accounts";
import { MarketingRequestError } from "./errors";
import type { ConnectedAccountInput } from "./plugins/types";
import { createMarketingTestDb } from "./__fixtures__/marketingDb";

const asClient = (db: { client: unknown }) => db.client as unknown as SupabaseClient;

const SECRET = "super-secret-token";

function input(over: Partial<ConnectedAccountInput> = {}): ConnectedAccountInput {
  return {
    provider: "fake",
    channel: "fake",
    externalId: "ext-1",
    externalParentId: "parent-1",
    handle: "@fakebrewing",
    credentials: { accessToken: SECRET },
    tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["fake.publish"],
    ...over,
  };
}

describe("the safe column list", () => {
  it("does not contain the credential column, which is the whole boundary", () => {
    expect(ACCOUNT_SAFE_COLUMNS).not.toContain("credentials");
  });
});

describe("storing a login", () => {
  it("inserts the first time and stores the credential where only the server can read it", async () => {
    const db = createMarketingTestDb();
    const stored = await upsertConnectedAccount(asClient(db), input(), { createdBy: "user-1" });

    expect(db.tables.marketing_connected_accounts).toHaveLength(1);
    expect(db.tables.marketing_connected_accounts[0].credentials).toEqual({ accessToken: SECRET });
    expect(db.tables.marketing_connected_accounts[0].created_by).toBe("user-1");

    expect(stored.channel).toBe("fake");
    expect(stored.status).toBe("connected");
    // What came back, whole. Not a spot check on one field.
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(Object.keys(stored)).not.toContain("credentials");
  });

  it("re-connecting the same (provider, channel) moves the row rather than duplicating it", async () => {
    const db = createMarketingTestDb();
    const first = await upsertConnectedAccount(asClient(db), input(), { createdBy: "user-1" });
    const second = await upsertConnectedAccount(
      asClient(db),
      input({ handle: "@newhandle", credentials: { accessToken: "second-token" } }),
      { createdBy: "user-2" },
    );

    expect(db.tables.marketing_connected_accounts).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.handle).toBe("@newhandle");
    expect(db.tables.marketing_connected_accounts[0].credentials).toEqual({ accessToken: "second-token" });
    // Who first connected the channel is a fact about the past.
    expect(db.tables.marketing_connected_accounts[0].created_by).toBe("user-1");
  });

  it("clears a previous failure, because a fresh credential makes yesterday's error stale", async () => {
    const db = createMarketingTestDb({
      marketing_connected_accounts: [
        {
          id: "acc-1",
          provider: "fake",
          channel: "fake",
          status: "error",
          last_error: "The token expired.",
          credentials: { accessToken: "dead" },
        },
      ],
    });

    const stored = await upsertConnectedAccount(asClient(db), input());
    expect(stored.status).toBe("connected");
    expect(stored.lastError).toBeNull();
    expect(stored.lastVerifiedAt).not.toBeNull();
  });

  it("keeps two channels of one provider apart", async () => {
    const db = createMarketingTestDb();
    await upsertConnectedAccount(asClient(db), input({ channel: "instagram" }));
    await upsertConnectedAccount(asClient(db), input({ channel: "facebook" }));
    expect(db.tables.marketing_connected_accounts.map((r) => r.channel)).toEqual(["instagram", "facebook"]);
  });
});

describe("disconnecting", () => {
  function connected() {
    return createMarketingTestDb({
      marketing_connected_accounts: [
        {
          id: "acc-1",
          provider: "fake",
          channel: "fake",
          external_id: "ext-1",
          handle: "@fakebrewing",
          status: "connected",
          credentials: { accessToken: SECRET },
          scopes: ["fake.publish"],
        },
      ],
    });
  }

  it("empties the credential and keeps the row, because deliveries are history", async () => {
    const db = connected();
    const account = await disconnectAccount(asClient(db), "acc-1");

    expect(db.tables.marketing_connected_accounts).toHaveLength(1);
    const row = db.tables.marketing_connected_accounts[0];
    expect(row.status).toBe("disconnected");
    expect(row.credentials).toEqual({});
    // Still identifiable: a delivery that went through this login can still say so.
    expect(row.handle).toBe("@fakebrewing");
    expect(account.id).toBe("acc-1");
    expect(JSON.stringify(account)).not.toContain(SECRET);
  });

  it("is idempotent — pressing the button twice is not a mistake", async () => {
    const db = connected();
    await disconnectAccount(asClient(db), "acc-1");
    const again = await disconnectAccount(asClient(db), "acc-1");
    expect(again.status).toBe("disconnected");
    expect(db.tables.marketing_connected_accounts).toHaveLength(1);
  });

  it("says so when there is no such account", async () => {
    const db = connected();
    await expect(disconnectAccount(asClient(db), "nope")).rejects.toBeInstanceOf(MarketingRequestError);
  });
});
