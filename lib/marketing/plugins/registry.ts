/**
 * The channel registry: `channel` → plugin, and the only way anything in
 * marketing reaches a channel.
 *
 * The worker, the compose screen and the settings screen all ask this module
 * what exists. None of them names a channel in its own source, which is what
 * makes adding one later a folder and a line rather than a survey.
 *
 * **Production ships with this registry empty.** The fake is the only plugin
 * that exists today and it is registered only outside production, so a
 * production build lists zero channels. That is not an edge case to be guarded
 * against with a "should never happen" — it is the state the chassis actually
 * ships in until a real channel lands, and every consumer is expected to render
 * it plainly: no channels connected, nothing to pick.
 */
import { createFakeChannelPlugin } from "./fake";
import type { ChannelPlugin } from "./types";

const channels = new Map<string, ChannelPlugin>();

/**
 * Add a plugin to the registry.
 *
 * Registering a channel key twice throws. A silent overwrite would mean the
 * plugin that publishes is whichever module happened to be imported last, which
 * is a bug that only shows up in production and only as a wrong post.
 */
export function registerChannel(plugin: ChannelPlugin): void {
  if (channels.has(plugin.channel)) {
    throw new Error(
      `marketing: channel "${plugin.channel}" is already registered (by provider "${channels.get(plugin.channel)?.provider}"). ` +
        `Channel keys are unique — pick a different key rather than replacing the existing plugin.`,
    );
  }
  channels.set(plugin.channel, plugin);
}

/** The plugin for a channel, or `undefined` when nothing is registered under that key. */
export function getChannel(channel: string): ChannelPlugin | undefined {
  return channels.get(channel);
}

/** Every registered plugin, in registration order. Empty in production. */
export function listChannels(): ChannelPlugin[] {
  return [...channels.values()];
}

// ── The fake, outside production only ──────────────────────────────────────
// Gated here, at the point of registration, rather than inside the fake: the
// fake is a plain factory that anyone may construct in a test, and it is this
// module that decides what a running app can see.
if (process.env.NODE_ENV !== "production") {
  registerChannel(createFakeChannelPlugin());
}
