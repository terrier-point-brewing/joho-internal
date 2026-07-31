---
name: order-sync-cron-webhook-incident
description: 2026-07-14 order-sync staleness investigation — cron registry drift bug + Square webhook api_version re-pin
metadata: 
  node_type: memory
  type: project
  originSessionId: a47df0cd-9f7a-4e75-b8e9-35d4d37c918f
---

User reported orders in Finance > Transactions were ~7 days stale and they had to manually trigger a sync. Investigated on branch `claude/order-sync-cron-webhook-5613a6`.

Findings:
- `finance-sync` Vercel cron (`app/api/cron/finance-sync/route.ts`, `vercel.json`) had actually run successfully every day since its creation (2026-07-08) per the `cron_runs` table — no gap. Not the root cause of ongoing staleness.
- **Real bug, fixed**: [lib/cron/registry.ts](../../../../Desktop/Coding/Git/tpb-square-reports/lib/cron/registry.ts) (the `CRON_JOBS` array backing the Settings → Cron Jobs monitor) was missing `finance-sync` and `tax-tasks` entirely — it was last edited 2026-07-04, before either of those cron routes existed, and nobody added them when they shipped (finance-sync 07-07, tax-tasks 07-12). `vercel.json` is the source of truth for schedules but `registry.ts` doesn't auto-derive from it, so it silently drifts whenever a new cron route ships without a matching registry entry. **Pattern to watch: adding a new `app/api/cron/*` route must always add a matching entry to `lib/cron/registry.ts`, or the monitor can't flag it if it goes overdue.**
- Live Square webhook subscription (`wbhk_efc8b47fec0c4abf937922b9331b3afc`, notification_url `https://tpb-square-reports.vercel.app/api/webhooks/square`) had drifted to `api_version: 2026-05-20` while the app's Square client (`lib/square/client.ts`) is pinned to `2025-04-16`. Subscription's `updated_at` (07-08) lines up with when invoice event types were added to it — editing event_types via Square's API/dashboard without pinning `api_version` lets Square default it to "latest," silently diverging from what the app's webhook parser expects. Re-pinned to `2025-04-16` via `PUT /v2/webhooks/subscriptions/{id}` with body `{subscription: {api_version: "2025-04-16"}}` — confirmed 200, all other fields (enabled/event_types/url) unchanged.
- Square has no public API for webhook delivery/failure history (dashboard-only), so couldn't directly confirm whether the version drift actually dropped events — this was a plausible-but-unconfirmed lead, acted on with user's explicit approval since it's a live third-party config change.

Status: registry.ts fix + webhook re-pin both applied on the branch/live subscription as of 2026-07-14. NOT yet merged/committed — awaiting user decision on commit/PR.
