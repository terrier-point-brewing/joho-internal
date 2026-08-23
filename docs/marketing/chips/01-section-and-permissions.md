# Chip 1 — Marketing section + permissions

**Read `docs/marketing/CONVENTIONS.md` in full before writing anything.** It is the
authority on how this repo does permissions, nav, page structure, migrations and
tests. Where this brief and the conventions sheet disagree, stop and report.

---

## 1. Intent (why any of this exists)

Marketing at the brewery is a coordination problem across weeks and channels: posts,
reels, stories, boosts, later email. We are building **one calendar** that holds all
of it, a **robot** that publishes what is on the calendar through pluggable channels,
and later an **assistant** that proposes what to put there. Humans approve; nothing
publishes or spends money without a human action.

This chip builds none of that. It builds the **door**: a sixth top-level section that
exists, is permission-gated, and cannot be imported by the rest of the app. Six later
chips fill it in.

The platform serves one brand. There is no brand switching anywhere in this app and
none here — no `brand_id`, no selector, no per-brand scoping, at any layer.

## 2. What this chip owns

### 2.1 Permission scopes

Add `"marketing"` to the `Section` union and **two** leaves to `SCOPES`
(`lib/auth/scopes.ts`):

| Scope | Label | Purpose |
|---|---|---|
| `marketing.access` | `Access` | Section admission. Read-gated in the layout, used for nothing else. |
| `marketing.accounts` | `Accounts` | Connected channel logins — the thing that holds tokens. |

Two more leaves are **designed and deliberately deferred**, because
`scripts/check-permissions.mjs --strict` fails on any scope no capability covers and
on any capability nothing references. Adding them now with no caller would break the
build:

- `marketing.calendar` — arrives with chip 5 (entry routes).
- `marketing.publish` — arrives with chip 4 (the worker).

Record both in a comment next to the marketing block in `scopes.ts` so the next chip
does not re-litigate the naming.

### 2.2 Capabilities

In `lib/auth/capabilities.ts`, under a `// ── Marketing ──` banner:

```ts
marketingAccess:         { scope: "marketing.access",   level: "read" },
marketingAccountsManage: { scope: "marketing.accounts", level: "manage" },
```

Both must be referenced by this chip's own code or the lint fails. They are — see 2.4.

### 2.3 Role bundles — no code change, and that is the point

**Do not edit `ROLE_BUNDLES`.**

Role bundles are *data*, not code. `role_permission_grants`
(`20260826_role_permission_grants.sql`) holds the live matrix; `getRoleBundle()` in
`lib/auth/roleBundles.server.ts` reads it with a 30s cache and falls back to the
`ROLE_BUNDLES` constant only when the table cannot be read. The constant is the seed
and the safety net — not the source of truth.

So opening Marketing to manager later is an **admin action in
Settings → Environment → Users**, not a deploy. What makes that possible is registering
the scopes in `SCOPES`, which is exactly what 2.1 does: `GrantMatrix.tsx` renders its
rows straight from `SCOPES`, so a newly registered scope becomes grantable in the UI
the moment it exists.

Two consequences for this chip:

- Editing the constant would put it out of sync with the seeded table and break
  `lib/auth/__tests__/roleBundleSeedParity.test.ts`, which parses the seed out of the
  migration and asserts byte-parity per role. Leave both alone.
- `admin` resolves marketing through its ROOT grant with no row of any kind, so
  Marketing is admin-visible from the first deploy and grantable to anyone else
  immediately, by a person, through the UI.

### 2.3a GrantMatrix section order (typecheck will force this)

`app/settings/environment/users/GrantMatrix.tsx` carries
`const _sectionOrderIsExhaustive: Record<Section, true>` precisely so that adding a
section without giving it a display row is a **compile error** rather than a section
missing from the grants UI. Adding `"marketing"` to the `Section` union therefore
requires adding it to that file's `SECTION_ORDER` / section-label map.

Place Marketing consistently with its sidebar position (after Brand). This is the one
file outside `app/marketing/` — besides `NavBar.tsx` and `lib/auth/*` — that this chip
touches, and it is required, not optional.

### 2.4 The section

```
app/marketing/
  layout.tsx          requirePage(CAP.marketingAccess); flex flex-col h-full shell, no padding
  page.tsx            redirectToFirstReachable → /marketing/calendar
  nav-config.ts       MARKETING_TABS
  calendar/page.tsx   stub
  accounts/page.tsx   stub
```

`nav-config.ts`, modelled on `app/brand/nav-config.tsx`:

```ts
export const MARKETING_TABS: MarketingNavEntry[] = [
  { href: "/marketing/calendar", label: "Calendar", requires: CAP.marketingAccess },
  { href: "/marketing/accounts", label: "Accounts", requires: CAP.marketingAccountsManage },
];
```

Two subtabs. No others, now or by this chip.

Each page gates on **exactly** what its subtab entry requires — a visible tab that
leads to a redirect is the specific bug this rule prevents.

Both stubs are real pages, not placeholders with lorem text: `StickyHeader` +
`PageHeader` + `SubNav`, then an empty-state card in the scrollable region saying what
will live there ("Scheduled posts appear here once a channel is connected." /
"No channels are connected."). They must be visually indistinguishable in style from
an existing section — **no new design language, no raw colors, no hand-rolled
buttons.** Copy the page shell from an existing section rather than inventing one.

### 2.5 Sidebar registration

`app/components/NavBar.tsx`: add the desktop section block, the `MobileNavItem` row,
an `isMarketing` pathname check, an inline SVG icon in the existing 14×14
`stroke-width 1.4` house style, and import `MARKETING_TABS`. Visibility uses
`can(CAP.marketingAccess)`, the same capability the layout gates on, so the sidebar
and the server-side redirect cannot drift.

Place Marketing after Brand, before Settings.

### 2.6 Boundary lint

New `scripts/check-marketing-boundary.mjs`, in the idiom of the existing
`scripts/check-*.mjs` (warn-only, `--strict` exits 1, plain Node, no new dependency).
Wire it into `npm run verify` as `check:marketing-boundary` with `--strict`.

Two rules:

1. **Nothing outside marketing imports marketing.** No file may import from
   `@/app/marketing/**` or `@/lib/marketing/**` unless it is itself under
   `app/marketing/`, `app/api/marketing/`, `lib/marketing/`, or
   `app/settings/marketing/`.
   *One allowlisted exception:* `app/components/NavBar.tsx` may import
   `@/app/marketing/nav-config`. Hard-code it as a named exception with a comment —
   every other section is imported by NavBar the same way, and pretending otherwise
   would mean the sidebar cannot render.

2. **Marketing imports the host narrowly.** A file under marketing may import from
   `@/lib/auth/**`, `@/lib/supabase/**`, `@/lib/utils/**`, `@/lib/cron/**`,
   `@/app/components/**`, `@/lib/marketing/**`, plus packages and relative paths
   within marketing. An import from any *other* section's `lib/` or `app/` is an
   error, with a message pointing at `lib/marketing/ports/` as the sanctioned route.

Head the file with a comment explaining *why* — marketing is the first part of this
app with an enforced boundary, and the next person needs to know it is deliberate.

### 2.7 Ports folder

Create `lib/marketing/ports/README.md` and nothing else. It describes the pattern:
an interface is **declared inside marketing**, the **host implements and registers**
it, it is **read-only**, and **marketing never writes through a port**. No interfaces,
no implementations, no consumers — later modules will need brand voice, active taps,
events, sales and budget caps; the chassis needs none of them.

## 3. Gate — all of these before you report done

**Automated**

- [ ] `npm run verify` green (includes the new boundary check).
- [ ] `npm run check:permissions -- --strict` green.
- [ ] `npm test` green — in particular `lib/auth/__tests__/roleBundleSeedParity.test.ts`, which fails if `ROLE_BUNDLES` was edited (see 2.3).
- [ ] `npm run check:migrations -- --strict` green (this chip adds no migration; the check must still pass).
- [ ] `npm run build` green. This is not in `verify` and catches the client-bundle trap: client code importing from the `@/lib/auth` barrel builds fine under `verify` and fails here.
- [ ] **Deliberate violation, both directions.** Temporarily add an import of `@/lib/marketing/ports` to a file in `app/finance/`, confirm the script exits 1 with a useful message, remove it. Then temporarily import something from `@/lib/finance/` inside `app/marketing/calendar/page.tsx`, confirm exit 1, remove it. Paste both failure messages into the report.

**Browser** (Claude in Chrome, per the conventions sheet — the repo has no UI test setup, so this is the real gate)

- [ ] **Settings → Environment → Users:** the grant matrix shows a **Marketing** section with `Access` and `Accounts` rows, and a level can be set on them. This is the proof that widening access later needs no deploy — screenshot it.
- [ ] Signed in as admin: **Marketing** appears in the sidebar after Brand; clicking it lands on Calendar; both subtabs render and switch.
- [ ] Both pages match the surrounding app — sticky header holds title + subtabs and nothing else, everything else scrolls.
- [ ] Screenshot both pages into the report.
- [ ] **Negative case:** confirm a principal without `marketing.access` neither sees the sidebar entry nor can reach `/marketing/calendar` directly (it redirects). If no such test account is available, prove it by temporarily clamping the grant, or say plainly that it was not proven — do not claim it untested.

## 4. Do not build

Not now, not stubbed, not "just the type":

- Any table, column, migration, or storage bucket. **Chip 1 touches no SQL at all.**
- Any API route under `app/api/marketing/`.
- The plugin contract, the registry, or the fake plugin.
- The worker, the cron entry, `vercel.json`, or anything in `lib/cron/`.
- The Settings → Marketing group. It arrives with chip 6.
- Any subtab beyond Calendar and Accounts — no Library, Plan, Ads, Insights.
- Compose, the media picker, entry detail, or any date/time control.
- The `marketing.calendar` and `marketing.publish` scopes (see 2.1).
- Any edit to `ROLE_BUNDLES` or to `20260826_role_permission_grants.sql` (see 2.3).
- Instagram, Facebook, Meta, Google, or any real channel or credential.
- Anything brand-scoped.

## 5. Report back

What was built · every gate result including the two lint failure messages and both
screenshots · anything you deviated from and why · anything in this brief that turned
out to be wrong about the repo. **If the design needs to change, stop and report —
do not improvise.**
