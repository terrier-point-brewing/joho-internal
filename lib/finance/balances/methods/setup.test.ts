/**
 * Readiness is the question the Settings header, the row status and the setup
 * panel all ask. These assert the answers that were previously wrong on screen.
 */
import { describe, it, expect } from "vitest";
import { resolveSetupState, type SetupConnectionRef, type SetupFacts } from "./setup";
import type { BalanceMethod, ConnectionProvider } from "./registry";

const base: Omit<BalanceMethod, "key" | "setup"> = {
  label: "Test method",
  kind: "calculation",
  summary: "A method for testing.",
  steps: [{ providerKey: "x", label: "Step", description: "d", source: "s", direction: "net" }],
};

const method = (setup: BalanceMethod["setup"]): BalanceMethod => ({ ...base, key: "test", setup });

const connection = (over: Partial<SetupConnectionRef> = {}): SetupConnectionRef => ({
  id: "conn-1",
  provider: "ramp",
  label: "Ramp · Operating",
  status: "active",
  ...over,
});

function facts(over: Partial<SetupFacts> = {}): SetupFacts {
  return {
    config: {},
    connectionsById: new Map(),
    operatorBalance: null,
    providerReadiness: new Map<ConnectionProvider, { configured: boolean; reason?: string }>([
      ["ramp", { configured: true }],
      ["square", { configured: true }],
      ["plaid", { configured: true }],
    ]),
    ...over,
  };
}

const connectionField = {
  kind: "connection" as const,
  key: "connectionId",
  provider: "ramp" as const,
  connect: "discover" as const,
  label: "Ramp account",
  help: "Choose which Ramp account this is.",
};

const operatorField = {
  kind: "operatorBalance" as const,
  key: "operatorBalance",
  label: "Balance",
  help: "Enter the balance you read.",
};

describe("resolveSetupState", () => {
  it("treats a method with no setup as ready", () => {
    // Transaction postings and the accrual pairs need nothing. They must not be
    // reported as unfinished, or every account on the screen would look broken.
    const state = resolveSetupState(method(undefined), facts());
    expect(state.ready).toBe(true);
    expect(state.fields).toEqual([]);
    expect(state.outstanding).toBeNull();
  });

  it("is NOT ready when a connection field names no connection", () => {
    // This is GL 1020's exact state: an active source, the Plaid method chosen,
    // and config.connectionId never set. The old screen counted it as one of
    // "12 of 48 accounts with an active source" while it produced nothing.
    const state = resolveSetupState(method([connectionField]), facts());
    expect(state.ready).toBe(false);
    expect(state.outstanding).toContain("No account is linked yet");
  });

  it("reports the app-level problem BEFORE the account-level one", () => {
    // "You have not linked an account" is misleading advice when there is no
    // way to link one. The unconfigured-service message has to win.
    const state = resolveSetupState(
      method([connectionField]),
      facts({
        providerReadiness: new Map([["ramp", { configured: false, reason: "Ramp is not set up for this app yet." }]]),
      }),
    );
    expect(state.fields[0].blocker).toBe("Ramp is not set up for this app yet.");
  });

  it("is not ready when the named connection has been deleted", () => {
    // resolveConnection returns null for a dangling id and the account silently
    // reads as unsourced. This is the only place that becomes visible.
    const state = resolveSetupState(method([connectionField]), facts({ config: { connectionId: "gone" } }));
    expect(state.ready).toBe(false);
    expect(state.fields[0].blocker).toContain("no longer exists");
  });

  it("is not ready when the connection needs reauthorising", () => {
    const state = resolveSetupState(
      method([connectionField]),
      facts({
        config: { connectionId: "conn-1" },
        connectionsById: new Map([["conn-1", connection({ status: "needs_reauth" })]]),
      }),
    );
    expect(state.ready).toBe(false);
    expect(state.fields[0].blocker).toContain("expired");
    // The label still shows: the operator needs to know WHICH connection broke.
    expect(state.fields[0].value).toBe("Ramp · Operating");
  });

  it("is ready when the connection is linked and active", () => {
    const state = resolveSetupState(
      method([connectionField]),
      facts({ config: { connectionId: "conn-1" }, connectionsById: new Map([["conn-1", connection()]]) }),
    );
    expect(state.ready).toBe(true);
    expect(state.outstanding).toBeNull();
  });

  it("accepts an operator balance from ANY earlier date, not just this month", () => {
    // The figure carries forward until superseded, so an account anchored last
    // month is configured and computing. Demanding the current month would make
    // every Square-style account read as unconfigured for most of the month.
    const state = resolveSetupState(
      method([operatorField]),
      facts({ operatorBalance: { asOfDate: "2026-06-30", cents: 426828 } }),
    );
    expect(state.ready).toBe(true);
    expect(state.fields[0].value).toContain("2026-06-30");
  });

  it("names the FIRST unmet field and counts the rest", () => {
    // Square's shape: linked but not anchored, or neither. A row has space for
    // a sentence, and the first thing to do is the only actionable one anyway.
    const state = resolveSetupState(method([connectionField, operatorField]), facts());
    expect(state.ready).toBe(false);
    expect(state.outstanding).toBe("Ramp account: No account is linked yet. (1 more to finish)");
  });

  it("does not let an optional field block readiness", () => {
    const state = resolveSetupState(
      method([{ kind: "text", key: "note", label: "Note", help: "Anything worth recording.", optional: true }]),
      facts(),
    );
    expect(state.ready).toBe(true);
    expect(state.fields[0].satisfied).toBe(false);
  });

  it("treats an empty string in config as unanswered", () => {
    // A cleared text input writes "", which is not the same as an answer.
    const state = resolveSetupState(
      method([{ kind: "text", key: "note", label: "Note", help: "Anything worth recording." }]),
      facts({ config: { note: "" } }),
    );
    expect(state.ready).toBe(false);
  });

  it("counts a zero number as answered", () => {
    // The falsy-zero trap: 0 is a legitimate rate, term or opening figure.
    const state = resolveSetupState(
      method([{ kind: "number", key: "rate", label: "Rate", help: "The rate to apply." }]),
      facts({ config: { rate: 0 } }),
    );
    expect(state.ready).toBe(true);
    expect(state.fields[0].value).toBe("0");
  });
});
