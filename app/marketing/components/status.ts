/**
 * Status → tone, in one place, for every marketing surface.
 *
 * Two ladders, because an entry and a delivery answer different questions: an
 * entry says how the whole post is doing, a delivery says how one channel is.
 * Both read through `Badge`'s `tone`, so a marketing pill is the same object as
 * a production one — see docs/UI_STANDARD.md §5.
 */
import type { Tone } from "@/app/components/ui/tone";
import type { EntryStatus } from "@/lib/marketing/plugins/types";

export const ENTRY_STATUS_TONE: Record<EntryStatus, Tone> = {
  draft: "neutral",
  approved: "accent",
  scheduled: "info",
  in_progress: "info",
  done: "success",
  failed: "danger",
};

export const ENTRY_STATUS_LABEL: Record<EntryStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  scheduled: "Scheduled",
  in_progress: "Publishing",
  done: "Posted",
  failed: "Failed",
};

/**
 * `marketing_deliveries.status`. `pending` is the ordinary state of a channel a
 * person picked on a draft — chosen, not queued — so it is neutral rather than
 * anything that reads as a problem.
 */
export const DELIVERY_STATUS_TONE: Record<string, Tone> = {
  pending: "neutral",
  scheduled: "info",
  publishing: "info",
  published: "success",
  failed: "danger",
  skipped: "neutral",
};

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  pending: "Chosen",
  scheduled: "Queued",
  publishing: "Publishing",
  published: "Posted",
  failed: "Failed",
  skipped: "Skipped",
};

/** `marketing_connected_accounts.status`. */
export const ACCOUNT_STATUS_TONE: Record<string, Tone> = {
  connected: "success",
  error: "danger",
  disconnected: "neutral",
};

export const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  connected: "Connected",
  error: "Error",
  disconnected: "Disconnected",
};

/**
 * A channel key as a person reads it. A plugin's key is lower-case and stable
 * ("instagram_business"); nothing in the contract carries a display name, so
 * this is the one place that guess is made rather than sprinkled per screen.
 */
export function channelLabel(channel: string): string {
  return channel
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Every entry kind Compose offers. Free text in the schema; plugins decide what they accept. */
export const ENTRY_KINDS = ["post", "reel", "story", "boost"] as const;
