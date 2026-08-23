/**
 * Instagram — the first real channel on the chassis.
 *
 * Everything Instagram-specific lives in this folder, and the only line outside
 * it is the registry's. The worker, the routes and the UI reach this plugin the
 * same way they reach the fake, and none of them was edited to make it work.
 *
 * ── The path taken: Instagram API with Facebook Login ───────────────────────
 * Two paths exist. This is the one that goes through a Facebook Page, because
 * Facebook is the next channel and this path serves both from one app, one
 * OAuth flow and one connected account. The cost is a hard dependency on the
 * Instagram account being a Business account linked to a Page, which it is.
 * `docs/marketing/modules/01-instagram.md` has the whole argument.
 *
 * Four permissions and no more: `instagram_basic`, `instagram_content_publish`,
 * `pages_read_engagement`, `pages_show_list`. Nothing here requests App Review,
 * or touches the ads use cases the same Meta app runs the brewery's real spend
 * through.
 *
 * ── The two credentials, and which one publishes ────────────────────────────
 * A connect ends with two tokens, and telling them apart is the difference
 * between a channel that keeps working and one that dies every sixty days:
 *
 *   * the **long-lived user token** expires in about 60 days. It is stored, and
 *     `tokenExpiresAt` describes it, so a future refresher has what it needs.
 *   * the **page token** derived from it does not expire at all. That is the one
 *     `publish` uses.
 *
 * So the answer to "what happens on day 61" is: publishing carries on. A
 * refresher is therefore **out of scope for this module and deliberately so** —
 * nothing in the chassis reads `token_expires_at` yet, giving it a reader is a
 * chassis change this module is not allowed to make, and the credential that
 * would actually stop a post is not the one that expires. When a refresher is
 * built, this row already holds the user token and its expiry.
 *
 * ── Idempotency, and the crash between the two steps ────────────────────────
 * Instagram publishes in two calls: create a container, then publish it. The
 * shape of that matters more than it looks, because a delivery is retryable and
 * a post cannot be un-posted. Three windows, three different answers, all of
 * them in {@link createInstagramChannelPlugin}'s `publish`:
 *
 *  1. **A delivery that already carries external ids.** Return them; contact
 *     nobody. This is the contract, and it is checked before anything else in
 *     the function — before the token is read, before a URL is built.
 *  2. **A crash between create and publish.** Nothing was posted: an unpublished
 *     container is not a post. It expires by itself after 24 hours, and a retry
 *     builds a fresh one, so exactly one post results. **No state needs to
 *     survive that crash**, which is the reason this plugin needs nothing from
 *     the chassis that the chassis does not already give it.
 *  3. **A `media_publish` whose answer never arrived.** This is the only
 *     genuinely dangerous window, and it is closed as far as it can be: the
 *     container id is still in hand, so the plugin asks Instagram what happened
 *     to it. `PUBLISHED` means the post exists and the delivery succeeds with
 *     the ids it has — a retry would have posted twice. Anything else fails, and
 *     a retry starts clean. What remains is a process that dies outright between
 *     the two, and no plugin and no chassis can close that: it is why retries
 *     here are human and never automatic.
 *
 * ── What comes back in `externalIds` ────────────────────────────────────────
 * The container, the published media id, the permalink, and one key per carousel
 * item. The permalink is there because `EntryDetailModal` renders any value that
 * is a URL as a link — the seam working as designed, with no URL template
 * anywhere in the chassis. Fetching it happens **after** the publish and can
 * never throw the publish away; a post nobody can link to is a nuisance, and a
 * post republished because a cosmetic GET failed is a disaster.
 *
 * ── Secrets ─────────────────────────────────────────────────────────────────
 * Nothing here logs. No error message contains a token, the app secret, or a
 * request URL. Tokens travel as bearer headers, never as query parameters — see
 * `./graph.ts`.
 */
import type {
  ChannelPlugin,
  ConnectedAccount,
  ConnectedAccountInput,
  Entry,
  Media,
  PublishContext,
  PublishResult,
  ValidationResult,
} from "../types";
import {
  GraphError,
  OAUTH_DIALOG_HOST,
  GRAPH_VERSION,
  createGraphTransport,
  requireString,
  type GraphTransport,
} from "./graph";
import { validateInstagram } from "./validate";

/**
 * The channel key, and it is not negotiable.
 *
 * The OAuth redirect URI registered with Meta ends in this exact word, Strict
 * Mode is on, and Meta matches the URI byte for byte. Renaming the channel
 * breaks the connect flow with an error message that does not mention the
 * rename.
 */
export const INSTAGRAM_CHANNEL = "instagram";

/** The service behind it. Facebook will be a second channel on the same provider. */
export const INSTAGRAM_PROVIDER = "meta";

/**
 * The four permissions, in the order they were configured on the app.
 *
 * `pages_show_list` is here because the callback resolves the Page — and the
 * Instagram account behind it — through `GET /me/accounts`, which Meta gates on
 * exactly this permission. `pages_read_engagement` covers reading a Page's
 * content and confers nothing about ENUMERATING the Pages a person manages, so
 * without this the endpoint answers with an empty list and connect fails at the
 * Page lookup with nothing wrong anywhere else. That is what happened on the
 * first live attempt.
 *
 * Configuring a permission on the Meta app is only half of it: the dialog
 * requests what this list names. A permission configured on the app but absent
 * here is never granted; one named here but not configured on the app is
 * silently dropped from the dialog. Both halves, or neither — and the failure
 * looks identical from the outside either way.
 *
 * `pages_show_list` is Standard Access: no App Review, and nothing near the ads
 * use cases this same app runs the brewery's real spend through.
 * `pages_manage_posts` belongs to the Facebook module and is not requested here.
 */
export const INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_read_engagement",
  "pages_show_list",
];

/**
 * The redirect URI, as a constant rather than as something derived.
 *
 * It is registered with Meta under Facebook Login for Business with Strict Mode
 * on, which means Meta compares it byte for byte and refuses anything else. A
 * value built from `NEXT_PUBLIC_APP_URL` would be correct in production and
 * quietly wrong everywhere else — a blank or localhost value produces a URI Meta
 * rejects with an error that says nothing about why. This is a fact about the
 * Meta app's registration, not about where this code happens to be running, so
 * it is written down as one. Registering a second URI means editing this line.
 */
export const INSTAGRAM_REDIRECT_URI = "https://internal.johobrewing.com/api/marketing/accounts/callback/instagram";

/** Options, which exist for the tests. There is one production configuration. */
export interface InstagramChannelOptions {
  /** Defaults to the real Graph transport. A stub here is how the tests run without a network. */
  transport?: GraphTransport;
}

/**
 * The credential this plugin stores.
 *
 * `pageAccessToken` is the one that publishes. The rest is what a later token
 * refresher, or a person debugging a connect, would otherwise have to guess.
 */
interface InstagramCredentials {
  pageAccessToken: string;
  userAccessToken: string;
  pageId: string;
  igUserId: string;
}

/**
 * An environment variable, or a sentence saying what to do about it.
 *
 * Read at call time rather than at import, the way `lib/env.ts` and
 * `lib/marketing/oauthState.ts` both do, so a missing variable surfaces on the
 * request that needed it instead of at boot. It is read here rather than through
 * `lib/env.ts` because marketing's import boundary does not admit that module,
 * and `oauthState.ts` set the precedent for exactly this case.
 */
function metaEnv(name: "META_APP_ID" | "META_APP_SECRET"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Connecting Instagram needs ${name} set. It is the Meta app's ` +
        `${name === "META_APP_ID" ? "App ID" : "App Secret"}, from App Dashboard → Settings → Basic.`,
    );
  }
  return value;
}

/**
 * The two things `publish` needs off a stored account, or a sentence saying
 * this login has to be made again.
 *
 * Only two: the page token and the Instagram user id. The rest of the stored
 * credential is there for a future refresher, and reading it here would make
 * publishing depend on fields publishing does not use.
 */
function publishCredentials(account: ConnectedAccount): { token: string; igUserId: string } {
  const token = account.credentials.pageAccessToken;
  if (typeof token !== "string" || token === "") {
    throw new Error(
      "This Instagram account has no usable page token stored. Reconnect it from Settings → Marketing and try again.",
    );
  }
  if (!account.externalId) {
    throw new Error(
      "This Instagram account has no Instagram user id stored. Reconnect it from Settings → Marketing and try again.",
    );
  }
  return { token, igUserId: account.externalId };
}

/** One page as `/me/accounts` returns it, as far as we read it. */
interface PageRow {
  id?: unknown;
  name?: unknown;
  access_token?: unknown;
  instagram_business_account?: { id?: unknown; username?: unknown } | null;
}

/**
 * Pick the one Page that has an Instagram Business account behind it.
 *
 * Refuses rather than guesses when there is more than one. A brewery has one
 * Page, so this will not fire — but "publish to whichever Page Meta listed
 * first" is not a behaviour worth having, and the day it would matter is the
 * day a post goes to the wrong brand.
 */
function pickInstagramPage(pages: PageRow[]): { pageId: string; pageToken: string; igUserId: string; username: string | null } {
  const withInstagram = pages.filter((p) => typeof p.instagram_business_account?.id === "string");

  if (withInstagram.length === 0) {
    throw new Error(
      pages.length === 0
        ? "Meta returned no Facebook Pages for this login. Either the person connecting does not administer the brewery's Page, " +
          "or the app's Instagram use case is missing the `pages_show_list` permission that listing Pages requires."
        : "None of the Facebook Pages on this login has an Instagram Business account linked to it. " +
          "Link the Instagram account to the Page in Meta Business Suite, then connect again.",
    );
  }

  if (withInstagram.length > 1) {
    const names = withInstagram.map((p) => (typeof p.name === "string" ? p.name : "an unnamed Page")).join(", ");
    throw new Error(
      `This login administers more than one Page with an Instagram account (${names}), and there is no way to say which one to post to. ` +
        "Connect with a login that reaches only the brewery's Page.",
    );
  }

  const page = withInstagram[0];
  const pageId = typeof page.id === "string" ? page.id : "";
  const pageToken = typeof page.access_token === "string" ? page.access_token : "";
  const igUserId = String(page.instagram_business_account?.id);
  const username = typeof page.instagram_business_account?.username === "string" ? page.instagram_business_account.username : null;

  if (!pageId || !pageToken) {
    throw new Error(
      "Meta returned the brewery's Page without an access token for it, which usually means the permissions were not all granted. " +
        "Connect again and accept every permission the dialog asks for.",
    );
  }

  return { pageId, pageToken, igUserId, username };
}

/** Meta's `expires_in` (seconds from now) as the ISO instant the table wants. */
function expiryFrom(body: Record<string, unknown>, nowMs: number): string | null {
  const seconds = body.expires_in;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(nowMs + seconds * 1000).toISOString();
}

/**
 * The Instagram channel plugin.
 *
 * One factory, one instance, registered once in `../registry.ts`.
 */
export function createInstagramChannelPlugin(options: InstagramChannelOptions = {}): ChannelPlugin {
  const transport = options.transport ?? createGraphTransport();

  /** Create one media container and return its id. */
  async function createContainer(igUserId: string, token: string, params: Record<string, string>): Promise<string> {
    const body = await transport.request({ method: "POST", path: `${igUserId}/media`, token, params });
    return requireString(body, "id", "the request to prepare an image");
  }

  /**
   * Ask Instagram what became of a container.
   *
   * Only ever called after a `media_publish` whose answer never arrived, and the
   * only question that matters is whether the answer is `PUBLISHED`.
   */
  async function containerStatus(containerId: string, token: string): Promise<string | null> {
    try {
      const body = await transport.request({
        method: "GET",
        path: containerId,
        token,
        params: { fields: "status_code" },
      });
      return typeof body.status_code === "string" ? body.status_code : null;
    } catch {
      // The recovery read failing tells us nothing new. The caller already has
      // a failure to report and will say the outcome is unknown.
      return null;
    }
  }

  return {
    channel: INSTAGRAM_CHANNEL,
    provider: INSTAGRAM_PROVIDER,

    connect: {
      /**
       * The Facebook OAuth dialog. `state` is round-tripped verbatim — the
       * chassis minted and signed it, and the callback route checks it before
       * anything else happens.
       */
      authUrl(state: string): string {
        const url = new URL(`${OAUTH_DIALOG_HOST}/${GRAPH_VERSION}/dialog/oauth`);
        url.searchParams.set("client_id", metaEnv("META_APP_ID"));
        url.searchParams.set("redirect_uri", INSTAGRAM_REDIRECT_URI);
        url.searchParams.set("state", state);
        url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
        url.searchParams.set("response_type", "code");
        return url.toString();
      },

      /**
       * Code → short-lived token → long-lived token → Page → Instagram account.
       *
       * Four steps and no shortcuts. The `state` argument is not read: the
       * callback route verified it before calling this, and re-checking it here
       * with a secret this module would have to learn about is a second place
       * to get it wrong.
       */
      async callback(code: string): Promise<ConnectedAccountInput> {
        const clientId = metaEnv("META_APP_ID");
        const clientSecret = metaEnv("META_APP_SECRET");

        // 1. The authorization code, for a short-lived user token.
        const shortLived = await transport.request({
          method: "POST",
          path: "oauth/access_token",
          params: {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: INSTAGRAM_REDIRECT_URI,
            code,
          },
        });
        const shortToken = requireString(shortLived, "access_token", "the authorization code exchange");

        // 2. That, for a long-lived one — about 60 days, and refreshable.
        const longLived = await transport.request({
          method: "POST",
          path: "oauth/access_token",
          params: {
            grant_type: "fb_exchange_token",
            client_id: clientId,
            client_secret: clientSecret,
            fb_exchange_token: shortToken,
          },
        });
        const userToken = requireString(longLived, "access_token", "the long-lived token exchange");
        const tokenExpiresAt = expiryFrom(longLived, Date.now());

        // 3. The Page, its own token, and the Instagram account behind it, in
        //    one round trip. A page token minted from a long-lived user token
        //    does not itself expire, which is why publishing survives day 61.
        const accounts = await transport.request({
          method: "GET",
          path: "me/accounts",
          token: userToken,
          params: { fields: "id,name,access_token,instagram_business_account{id,username}" },
        });
        const pages = Array.isArray(accounts.data) ? (accounts.data as PageRow[]) : [];
        const { pageId, pageToken, igUserId, username } = pickInstagramPage(pages);

        const credentials: InstagramCredentials = {
          pageAccessToken: pageToken,
          userAccessToken: userToken,
          pageId,
          igUserId,
        };

        return {
          provider: INSTAGRAM_PROVIDER,
          channel: INSTAGRAM_CHANNEL,
          externalId: igUserId,
          externalParentId: pageId,
          handle: username ? `@${username}` : null,
          credentials: { ...credentials },
          tokenExpiresAt,
          scopes: [...INSTAGRAM_SCOPES],
        };
      },
    },

    validate(entry: Entry, media: Media[]): ValidationResult {
      return validateInstagram(entry, media);
    },

    async publish(ctx: PublishContext): Promise<PublishResult> {
      // ── Idempotency, before anything else ────────────────────────────────
      // Non-empty means this delivery has already gone out. Return the ids and
      // contact nobody: not Meta, not the environment, not even to read a
      // token. You cannot un-post, and every delivery here is retryable.
      if (Object.keys(ctx.externalIds).length > 0) {
        return { externalIds: { ...ctx.externalIds } };
      }

      const { token, igUserId } = publishCredentials(ctx.account);
      const caption = ctx.entry.caption ?? "";
      const media = ctx.media;

      // The worker validates before it publishes, and the retry route goes
      // through the worker, so reaching here with nothing to post means the
      // chassis changed under us. Refuse rather than ask Meta to.
      if (media.length === 0) {
        throw new Error("There is no image on this entry, so there is nothing to post to Instagram.");
      }

      const externalIds: Record<string, string> = {};

      // ── Step 1: the container (or, for a carousel, all of them) ───────────
      // Sequential, in `ctx.media` order, which the worker ordered by
      // `marketing_entry_media.position`. A carousel published in the wrong
      // order is a post that has to be deleted.
      let containerId: string;
      if (media.length === 1) {
        containerId = await createContainer(igUserId, token, { image_url: media[0].url, caption });
      } else {
        const childIds: string[] = [];
        for (const [index, item] of media.entries()) {
          const childId = await createContainer(igUserId, token, { image_url: item.url, is_carousel_item: "true" });
          externalIds[`item-${index + 1}`] = childId;
          childIds.push(childId);
        }
        containerId = await createContainer(igUserId, token, {
          media_type: "CAROUSEL",
          children: childIds.join(","),
          caption,
        });
      }
      externalIds.container = containerId;

      // Nothing has been posted yet. A failure above leaves containers that
      // Instagram discards after 24 hours and a retry that starts clean.

      // ── Step 2: publish it ───────────────────────────────────────────────
      let mediaId: string;
      try {
        const published = await transport.request({
          method: "POST",
          path: `${igUserId}/media_publish`,
          token,
          params: { creation_id: containerId },
        });
        mediaId = requireString(published, "id", "the request to publish the post");
      } catch (err) {
        // The dangerous window. If Meta refused outright, nothing was posted and
        // a retry is safe. If we simply never heard back, the post may exist —
        // so ask the container what happened to it before deciding.
        const unknown = err instanceof GraphError && err.outcomeUnknown;
        if (!unknown) throw err;

        const status = await containerStatus(containerId, token);
        if (status === "PUBLISHED") {
          // It went out. Returning ids marks the delivery published, which is
          // what stops a person's retry from posting it a second time. The
          // media id is not recoverable from here and is not invented.
          return { externalIds: { ...externalIds, container_status: "PUBLISHED" } };
        }
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} ` +
            (status === null
              ? "Instagram could not confirm whether the post went out — check the account before retrying."
              : `Instagram reports the prepared post as ${status}, so nothing was published.`),
        );
      }

      externalIds.media = mediaId;

      // ── After this line nothing may throw ────────────────────────────────
      // The post exists. An exception from here would lose the ids above, and a
      // retry with an empty bag posts a second time. The permalink is a
      // convenience; it is not worth a duplicate post.
      try {
        const detail = await transport.request({
          method: "GET",
          path: mediaId,
          token,
          params: { fields: "permalink" },
        });
        if (typeof detail.permalink === "string" && detail.permalink !== "") {
          externalIds.permalink = detail.permalink;
        }
      } catch {
        // No permalink, and that is all it means. The media id is in the bag
        // and the post is on the account.
      }

      return { externalIds };
    },
  };
}
