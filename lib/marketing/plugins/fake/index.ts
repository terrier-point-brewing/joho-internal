/**
 * The fake channel plugin — test and dev only.
 *
 * This is the instrument the rest of the chassis is measured with. The worker,
 * the compose screen and the settings screen are all proven against it before a
 * single real credential exists, so it has to be two things at once: honest
 * about the contract, and completely controllable.
 *
 * Two rules follow from that, and neither is negotiable:
 *
 *  1. **No I/O and no ambient state.** No network, no timers, no `Date.now()`,
 *     no `Math.random()`. Every value it returns is derived from its arguments
 *     or from a fixed constant. A flaky fake would poison every test that uses
 *     it, and those tests are the only evidence the chassis works.
 *  2. **Nothing global.** `createFakeChannelPlugin()` hands back a fresh
 *     instance with its own outcome setting, its own attempt counter and its own
 *     call log. Two tests can drive two fakes without seeing each other.
 *
 * It also carries the contract's sharpest requirement — idempotency on retry —
 * so that the behaviour every real plugin must have is pinned down here, in
 * something we control, rather than discovered against a live provider.
 */
import type {
  ChannelPlugin,
  ConnectedAccountInput,
  Entry,
  Media,
  PublishContext,
  PublishResult,
  ValidationResult,
} from "../types";

/** The channel key the fake registers under. */
export const FAKE_CHANNEL = "fake";

/** The provider behind it. Not a real service, and never will be. */
export const FAKE_PROVIDER = "fake";

/**
 * A far-future, fixed expiry for the credential `callback` mints.
 *
 * Fixed rather than "now + an hour" because the fake must not read the clock:
 * a test asserting on the account it produced has to get the same string in
 * March as in November.
 */
export const FAKE_TOKEN_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

/** The longest caption the fake pretends its channel accepts. */
export const FAKE_CAPTION_LIMIT = 2200;

/**
 * How the instance behaves when asked to publish.
 *
 * - `succeed` — publishes, every time.
 * - `fail` — rejects, every time.
 * - `succeed-after-retry` — rejects the first real publish attempt, then
 *   succeeds. This is the shape the worker's retry path is tested against.
 *
 * Note that an idempotent hit (see {@link createFakeChannelPlugin}) is not an
 * attempt: a delivery that already carries external ids never reaches the
 * outcome logic at all, so a `fail` fake still returns them happily.
 */
export type FakeOutcome = "succeed" | "fail" | "succeed-after-retry";

/**
 * One recorded call, in the order it happened.
 *
 * The arguments are kept whole rather than summarised, so a test can assert on
 * exactly what the chassis handed over — which entry, which media, in which
 * order, carrying which external ids.
 */
export type FakeCall =
  | { method: "authUrl"; state: string; url: string }
  | { method: "callback"; code: string; state: string }
  | { method: "validate"; entry: Entry; media: Media[]; result: ValidationResult }
  | { method: "publish"; ctx: PublishContext; outcome: FakePublishOutcome };

/**
 * What a recorded `publish` actually did.
 *
 * `reused` is the important one: it is how a test proves the plugin honoured
 * the delivery's existing external ids and did **not** publish a second time.
 * A retry that shows `published` twice is the bug this whole mechanism exists
 * to catch.
 */
export type FakePublishOutcome = "published" | "reused" | "failed";

export interface FakeChannelOptions {
  /** Defaults to `"fake"`. Give a second instance its own key to register both. */
  channel?: string;
  /** Defaults to `"fake"`. */
  provider?: string;
  /** Defaults to `"succeed"`. */
  outcome?: FakeOutcome;
  /**
   * Replace the default validation rules wholesale.
   *
   * The default rules are plausible but arbitrary; a test that needs a channel
   * to refuse (or accept) a specific entry should say so directly rather than
   * construct an entry that happens to trip a rule.
   */
  validate?: (entry: Entry, media: Media[]) => ValidationResult;
}

/** The fake's controls, on top of the contract every plugin satisfies. */
export interface FakeChannelPlugin extends ChannelPlugin {
  /** Every call so far, oldest first. */
  readonly calls: readonly FakeCall[];
  /** Change the outcome mid-flight — the registered instance is reachable only via `getChannel`. */
  setOutcome(outcome: FakeOutcome): void;
  /** The outcome currently in force. */
  getOutcome(): FakeOutcome;
  /** How many times `publish` has actually run the outcome logic. Idempotent hits do not count. */
  publishAttempts(): number;
  /** Clear the call log and the attempt counter. Leaves the outcome alone. */
  reset(): void;
}

/**
 * The fake's default answer to `validate`.
 *
 * Three rules, chosen because each one is a thing a real channel genuinely
 * refuses, and because together they give both a happy and an unhappy path
 * without needing a stub. Every reason is a sentence a person can act on.
 */
function defaultValidate(entry: Entry, media: Media[]): ValidationResult {
  const reasons: string[] = [];
  const caption = entry.caption ?? "";

  if (entry.kind === "reel" && !media.some((m) => m.type === "video")) {
    reasons.push("A reel needs a video.");
  }
  if (caption.trim() === "" && media.length === 0) {
    reasons.push("An entry needs either a caption or a piece of media before it can be posted.");
  }
  if (caption.length > FAKE_CAPTION_LIMIT) {
    reasons.push(`This caption is ${caption.length} characters. The limit is ${FAKE_CAPTION_LIMIT}.`);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Create an independent fake plugin.
 *
 * Everything it returns is a pure function of its arguments, so two runs of the
 * same test produce byte-identical results.
 */
export function createFakeChannelPlugin(options: FakeChannelOptions = {}): FakeChannelPlugin {
  const channel = options.channel ?? FAKE_CHANNEL;
  const provider = options.provider ?? FAKE_PROVIDER;
  const validateWith = options.validate ?? defaultValidate;

  let outcome: FakeOutcome = options.outcome ?? "succeed";
  let attempts = 0;
  const calls: FakeCall[] = [];

  return {
    channel,
    provider,

    connect: {
      authUrl(state: string): string {
        // A fixed, obviously-not-real host. `state` is round-tripped verbatim,
        // encoded, so a test can assert the chassis's CSRF token survived.
        const url = `https://fake.marketing.invalid/oauth/authorize?client_id=fake-client&state=${encodeURIComponent(state)}`;
        calls.push({ method: "authUrl", state, url });
        return url;
      },

      async callback(code: string, state: string): Promise<ConnectedAccountInput> {
        calls.push({ method: "callback", code, state });
        // No exchange happens. The values are plausible and derived from `code`
        // so that two different codes give two distinguishable accounts.
        return {
          provider,
          channel,
          externalId: `fake-account-${code}`,
          externalParentId: `fake-parent-${code}`,
          handle: "@fakebrewing",
          credentials: { accessToken: `fake-access-token-${code}` },
          tokenExpiresAt: FAKE_TOKEN_EXPIRES_AT,
          scopes: ["fake.read", "fake.publish"],
        };
      },
    },

    validate(entry: Entry, media: Media[]): ValidationResult {
      const result = validateWith(entry, media);
      calls.push({ method: "validate", entry, media, result });
      return result;
    },

    async publish(ctx: PublishContext): Promise<PublishResult> {
      // ── Idempotency, before anything else ────────────────────────────────
      // A delivery that already carries external ids has already been
      // published. Returning them is the whole behaviour: no attempt is
      // counted, no outcome is consulted, and — in a real plugin — the
      // provider is not contacted. `reused` in the call log is the proof.
      if (Object.keys(ctx.externalIds).length > 0) {
        calls.push({ method: "publish", ctx, outcome: "reused" });
        return { externalIds: { ...ctx.externalIds } };
      }

      attempts += 1;
      const shouldFail = outcome === "fail" || (outcome === "succeed-after-retry" && attempts === 1);

      if (shouldFail) {
        calls.push({ method: "publish", ctx, outcome: "failed" });
        throw new Error(`fake channel "${channel}" failed to publish entry ${ctx.entry.id} (outcome: ${outcome}, attempt ${attempts})`);
      }

      // Two ids, not one, because a real channel routinely mints several — a
      // media container and then the post made from it. Derived from the entry
      // so a retry that wrongly re-published would still be caught by the call
      // log rather than by a changed id.
      const externalIds = {
        container: `fake-container-${ctx.entry.id}`,
        post: `fake-post-${ctx.entry.id}`,
      };
      calls.push({ method: "publish", ctx, outcome: "published" });
      return { externalIds };
    },

    get calls(): readonly FakeCall[] {
      return calls;
    },

    setOutcome(next: FakeOutcome): void {
      outcome = next;
    },

    getOutcome(): FakeOutcome {
      return outcome;
    },

    publishAttempts(): number {
      return attempts;
    },

    reset(): void {
      calls.length = 0;
      attempts = 0;
    },
  };
}
