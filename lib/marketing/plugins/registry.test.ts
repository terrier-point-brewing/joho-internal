/**
 * The registry has one job and one trap.
 *
 * The job: `channel → plugin`, so nothing else in marketing names a channel.
 *
 * The trap: the fake is registered only outside production, which means the
 * registry a production build sees is EMPTY. Every consumer has to survive that,
 * so both branches are tested here rather than only the one the test runner
 * happens to be in.
 *
 * Each case re-imports the module under `vi.resetModules()`, because a registry
 * is a module-level map by nature: a test that registered a channel must not
 * leave it lying around for the next one.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { createFakeChannelPlugin, FAKE_CHANNEL } from "./fake";

type Registry = typeof import("./registry");

/** A registry module evaluated fresh, under the given NODE_ENV. */
async function freshRegistry(nodeEnv: "production" | "development" | "test"): Promise<Registry> {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  return import("./registry");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("marketing channel registry", () => {
  it("registers, gets and lists a plugin", async () => {
    const { registerChannel, getChannel, listChannels } = await freshRegistry("production");
    const plugin = createFakeChannelPlugin({ channel: "north", provider: "acme" });

    registerChannel(plugin);

    expect(getChannel("north")).toBe(plugin);
    expect(listChannels()).toEqual([plugin]);
  });

  it("lists plugins in registration order", async () => {
    const { registerChannel, listChannels } = await freshRegistry("production");
    const first = createFakeChannelPlugin({ channel: "one" });
    const second = createFakeChannelPlugin({ channel: "two" });

    registerChannel(first);
    registerChannel(second);

    expect(listChannels().map((p) => p.channel)).toEqual(["one", "two"]);
  });

  it("throws rather than silently replacing a channel registered twice", async () => {
    const { registerChannel } = await freshRegistry("production");
    registerChannel(createFakeChannelPlugin({ channel: "north", provider: "acme" }));

    expect(() => registerChannel(createFakeChannelPlugin({ channel: "north", provider: "other" }))).toThrow(
      /already registered/,
    );
  });

  it("answers undefined for a channel nobody registered", async () => {
    const { getChannel } = await freshRegistry("production");

    expect(getChannel("instagram")).toBeUndefined();
  });

  it("registers the fake outside production", async () => {
    const { getChannel, listChannels } = await freshRegistry("development");

    expect(listChannels().map((p) => p.channel)).toEqual([FAKE_CHANNEL]);
    expect(getChannel(FAKE_CHANNEL)?.provider).toBe("fake");
  });

  it("registers the fake under the test environment too", async () => {
    const { listChannels } = await freshRegistry("test");

    expect(listChannels().map((p) => p.channel)).toEqual([FAKE_CHANNEL]);
  });

  it("registers nothing in production — the empty registry every consumer must render", async () => {
    const { getChannel, listChannels } = await freshRegistry("production");

    expect(listChannels()).toEqual([]);
    expect(getChannel(FAKE_CHANNEL)).toBeUndefined();
  });

  it("still accepts a real registration in production — only the fake is gated, not the mechanism", async () => {
    const { registerChannel, listChannels } = await freshRegistry("production");
    registerChannel(createFakeChannelPlugin({ channel: "instagram", provider: "meta" }));

    expect(listChannels().map((p) => p.channel)).toEqual(["instagram"]);
  });
});
