# Module 1 — Instagram

The first real channel. Everything before this was proven with a fake plugin; this is
the module that finds out whether the chassis was right.

**Read `docs/marketing/README.md` and `docs/marketing/CONVENTIONS.md` first.** The
chassis is built, merged, and documented; this module adds to it and changes none of it.

---

## 1. Intent

Joho publishes to Instagram — feed posts and carousels — from the marketing calendar,
through the same Compose screen and the same worker that already exist. A person picks
Instagram, presses Post now, and the post appears. Nothing publishes without that
human action.

This module should be **one folder and one registry line**, plus whatever Instagram's
own rules force into `validate`. If it turns out to need more than that, **that is a
finding about the chassis and must be reported, not worked around.** The chassis was
built on the claim that a channel is a plugin; this is the test of that claim.

## 2. The API path — Facebook Login

Two paths exist. We take **Instagram API with Facebook Login**, because Facebook is
the next module and this path serves both channels from one app, one OAuth flow, and
one connected account.

The cost is a hard dependency: **the Instagram Business account must be linked to a
Facebook Page.** The Instagram-Login path avoids the Page but cannot post to Facebook
at all, which would mean a second app and a second connect flow a few months from now.

Permissions to request: `instagram_basic`, `instagram_content_publish`,
`pages_read_engagement`. Facebook posting later adds `pages_manage_posts` — do not
request it now.

**No App Review.** The app stays in Development mode with the Instagram account holding
a Tester role, which is all Standard Access needs when the only account published to is
our own. Switching the app to Live is what would trigger review; do not.

## 3. What this module owns

`lib/marketing/plugins/instagram/` and one line in `lib/marketing/plugins/registry.ts`.

### 3.1 `connect`

- `authUrl(state)` — the Facebook OAuth dialog, scoped to the three permissions above, round-tripping `state` verbatim.
- `callback(code, state)` — exchange for a token, **exchange that for a long-lived token**, resolve the Page and the Instagram Business account id behind it, and return a `ConnectedAccountInput`. `externalId` is the IG user id; `externalParentId` is the Page id; `handle` is the @username.

Long-lived tokens last around 60 days and are refreshable. `token_expires_at` exists on
the table and nothing reads it yet — this module is where that starts mattering.
**Decide and state** whether refresh is in scope here or a follow-up; do not leave it
implicit.

### 3.2 `validate`

Instagram's rules, as sentences a person can act on. At minimum: aspect-ratio bounds,
image format and size, caption length (2,200), hashtag count (30), and carousel item
count (2–10).

`validate` is synchronous and may not call the network.

### 3.3 `publish`

Instagram's two-step publish: create a media container, then publish it. A carousel is
a container per item plus a parent container.

**Every id goes in `externalIds`** — the container and the published media — because
that map is the idempotency key. If `ctx.externalIds` is non-empty, return it and
contact nobody. The fake plugin already specifies this behaviour and the worker is
tested against it.

The creative is fetched **by Instagram from a URL we hand it**, which is why
`marketing-media` is a public bucket. That part of the chassis is already right.

## 4. What it needs from the chassis

Nothing new is the expected answer. Known-good:

- The registry, the worker, the claim, retry, and inline Post-now all work unchanged.
- `marketing_connected_accounts` holds `credentials` server-side only.
- The public media bucket is what Instagram's fetch requires.

Known gaps this module will meet, none of them blockers:

- **A published delivery has no link.** `PublishResult` is a bag of ids and the chassis has no URL template. Instagram media ids do map to permalinks, so this module may **return a permalink as one of its `externalIds`**, which the UI already renders as a link when a value is a URL. That is the seam working as designed — no chassis change.
- **`token_expires_at` has no refresher.** See §3.1.
- **Scheduling is disabled**, so Post now is the only path. Fine, and unrelated.

## 5. Not in this module

Reels or any video — the schema accepts `video` and the chassis handles it nowhere, so
reels wait for the video module. Stories. Boosts, ads, or spend of any kind. Insights
or metrics writing. Facebook, which is the next module and shares the app, not this
folder. Comment management. Anything that switches the Meta app to Live mode.

## 6. What Will has to do — none of this is code

1. **Instagram account → Professional → Business.** Not Creator: Meta's docs say either works, but Creator is widely reported to fail on publishing, and the switch is free.
2. **A Facebook Page for the brewery**, if one does not exist, **linked to that Instagram account.** This is the Facebook-Login path's price, and what makes the Facebook module cheap later.
3. **A Meta app**, left in **Development mode**.
4. **The Instagram account added as a Tester** on that app, with the invite accepted from Instagram.
5. **Credentials into the environment, never into chat** — `META_APP_ID`, `META_APP_SECRET`, and `MARKETING_OAUTH_STATE_SECRET` (any random 32-byte hex), in Vercel and in `.env.local`.
6. **Page Publishing Authorization**, if the Page asks for it.

Steps 1–4 are roughly twenty minutes and block nothing else.

## 7. Definition of done

- The Meta app is in Development mode, never Live, and no App Review was submitted.
- Connect runs end to end from Settings → Marketing: the OAuth round trip stores a long-lived token, the handle renders, the status reads connected. A tampered `state` is refused.
- `credentials` cannot appear in any response, log line, or error, verified the way chip 5 verified it.
- `validate` refuses a caption over 2,200 characters, a carousel of 11, and a wrong aspect ratio — each with a sentence, shown greyed in Compose.
- **A single image post publishes to the real account**, and the entry reaches `done`.
- **A carousel of three publishes**, in the order Compose showed.
- Every `externalId` is stored, and a permalink renders as a link in entry detail.
- **Retry on an already-published delivery contacts Instagram zero times** and republishes nothing. This is the assertion the whole chassis was arranged around; prove it against the real API, not the fake.
- A forced failure leaves the delivery `failed` with a readable error, and Retry then succeeds.
- `npm run verify`, `check:permissions --strict`, `build` green; the boundary check still passes.
- Every test post is deleted from the real Instagram account afterwards, and every row from the database.
- **A written answer to: did the chassis need to change?** If yes, what and why. That answer is the real deliverable of this module.
