/**
 * The registry has one job and one trap.
 *
 * The job: `channel → plugin`, so nothing else in marketing names a channel.
 *
 * The trap: what a build actually sees depends on where it is running. The fake
 * is registered only outside production; Instagram, the first real channel, is
 * registered everywhere. Both are asserted here rather than only the one the
 * test runner happens to be in, because a consumer that assumed the wrong set
 * would only find out in production.
 *
 * Each case re-imports the module under `vi.resetModules()`, because a registry
 * is a module-level map by nature: a test that registered a channel must not
 * leave it lying around for the next one.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { createFakeChannelPlugin, FAKE_CHANNEL } from "./fake";
import { INSTAGRAM_CHANNEL } from "./instagram";

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
    expect(listChannels()).toContain(plugin);
  });

  it("lists plugins in registration order", async () => {
    const { registerChannel, listChannels } = await freshRegistry("production");
    const first = createFakeChannelPlugin({ channel: "one" });
    const second = createFakeChannelPlugin({ channel: "two" });

    registerChannel(first);
    registerChannel(second);

    // Instagram is registered by the module itself and therefore comes first.
    expect(listChannels().map((p) => p.channel)).toEqual([INSTAGRAM_CHANNEL, "one", "two"]);
  });

  it("throws rather than silently replacing a channel registered twice", async () => {
    const { registerChannel } = await freshRegistry("production");
    registerChannel(createFakeChannelPlugin({ channel: "north", provider: "acme" }));

    expect(() => registerChannel(createFakeChannelPlugin({ channel: "north", provider: "other" }))).toThrow(
      /already registered/,
    );
  });

  it("refuses to let a second plugin take a registered channel's key", async () => {
    const { registerChannel } = await freshRegistry("production");

    // The key Instagram holds is the one Meta's redirect URI is registered
    // against, so a module that quietly took it would break the connect flow.
    expect(() => registerChannel(createFakeChannelPlugin({ channel: INSTAGRAM_CHANNEL }))).toThrow(/already registered/);
  });

  it("answers undefined for a channel nobody registered", async () => {
    const { getChannel } = await freshRegistry("production");

    expect(getChannel("tiktok")).toBeUndefined();
  });

  it("registers Instagram in production", async () => {
    const { getChannel, listChannels } = await freshRegistry("production");

    expect(listChannels().map((p) => p.channel)).toEqual([INSTAGRAM_CHANNEL]);
    expect(getChannel(INSTAGRAM_CHANNEL)?.provider).toBe("meta");
    expect(getChannel(FAKE_CHANNEL)).toBeUndefined();
  });

  it("registers the fake alongside Instagram outside production", async () => {
    const { getChannel, listChannels } = await freshRegistry("development");

    expect(listChannels().map((p) => p.channel)).toEqual([INSTAGRAM_CHANNEL, FAKE_CHANNEL]);
    expect(getChannel(FAKE_CHANNEL)?.provider).toBe("fake");
  });

  it("registers the fake under the test environment too", async () => {
    const { listChannels } = await freshRegistry("test");

    expect(listChannels().map((p) => p.channel)).toEqual([INSTAGRAM_CHANNEL, FAKE_CHANNEL]);
  });

  it("still accepts a real registration in production — only the fake is gated, not the mechanism", async () => {
    const { registerChannel, listChannels } = await freshRegistry("production");
    registerChannel(createFakeChannelPlugin({ channel: "facebook", provider: "meta" }));

    expect(listChannels().map((p) => p.channel)).toEqual([INSTAGRAM_CHANNEL, "facebook"]);
  });
});
