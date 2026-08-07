-- ============================================================================
-- Brand canon + labels — close the anon read surface.
--
-- WHAT WAS OPEN
--   brand_canon_versions carried `brand_canon_read_published` (SELECT, roles =
--   PUBLIC, using status = 'published') and brand_labels carried
--   `brand_labels_read_approved` (SELECT, PUBLIC, using status = 'approved').
--   PUBLIC includes anon, and anon holds the table grant, so the published
--   canon row was fetchable unauthenticated over /rest/v1 — verified against
--   prod before this migration. brand_labels had 0 approved rows, so it was
--   not exposed yet; it is closed here so the first approval doesn't open it.
--
-- WHY IT WAS OPEN
--   20260808 granted anon SELECT deliberately ("a future public site reads
--   them"). No such site exists. What made the grant load-bearing instead of
--   merely speculative was lib/brand/getCanon.ts, which read the canon with
--   the cookieless ANON client — so the public Data API had to stay open just
--   so the server could style its own pages. getCanon() runs in the root
--   layout via BrandStyle/BrandFontFace/BrandChrome, i.e. on every route, and
--   used the anon key even for signed-in users.
--
-- WHY DROPPING THE POLICY IS SAFE NOW
--   getCanon() reads with the service-role client as of this change, matching
--   its sibling getBrandChromeEnabled() in the same layout. service_role
--   bypasses RLS, so rendering is unaffected. Every other consumer already
--   used the admin client (lib/brand/canonWorkflow.ts, lib/brand/labels.ts),
--   and no browser code reads either table — so `authenticated` needs no
--   policy either, and gets none.
--
-- POSTURE — service-role-only, the same tier 20260709 established for the
--   finance group. Both tables keep RLS enabled with zero policies, which is
--   what every other brand table already looks like (brand_assets,
--   brand_outputs, brand_releases, brand_seasons, brand_templates all sit at
--   service-role-only and all report advisor 0008 rls_enabled_no_policy INFO).
--   Expect two more 0008 INFO findings after this; that is the intended shape,
--   not a regression.
--
--   A future public brand site has to re-open access deliberately — a policy
--   naming anon and the surface that needs it — rather than inheriting a door
--   left ajar. Writes were already service-role-only and stay that way
--   (publishing is admin-gated at app/api/brand/canon/publish/route.ts).
-- ============================================================================

drop policy if exists brand_canon_read_published on public.brand_canon_versions;
drop policy if exists brand_labels_read_approved on public.brand_labels;

-- Belt to the suspenders: with no policy, RLS already yields zero rows for
-- anon and authenticated. Revoking the table grant makes the intent explicit
-- at the privilege layer too, so re-adding a policy alone cannot silently
-- reopen the REST surface.
revoke all on public.brand_canon_versions from anon;
revoke all on public.brand_labels from anon;

comment on table public.brand_canon_versions is
  'Versioned brand identity document; one published row governs --color-brand-* app-wide. SERVICE-ROLE ONLY: read via lib/brand/getCanon.ts (admin client), written via lib/brand/canonWorkflow.ts. No anon/authenticated policy by design — see 20261003090001.';

comment on table public.brand_labels is
  'Per-beer brand label records. SERVICE-ROLE ONLY: read/written via lib/brand/labels.ts (admin client). No anon/authenticated policy by design — see 20261003090001.';
