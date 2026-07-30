-- Brand canon change entries — the structured, auto-generated changelog written
-- at publish time by lib/brand/diffCanon.ts.
--
-- The existing `changelog` text column stays as the rendered markdown summary
-- (and still carries an optional founder note). This column holds the machine-
-- readable entries behind it, so the History tab can group by subtab and expand
-- individual changes rather than showing one opaque string.
--
-- Shape: ChangeEntry[] — see lib/brand/diffCanon.ts
--   [{ "section": "color", "kind": "changed",
--      "label": "Seal Red hex: #ad1a2d → #a51829",
--      "path": "palette.<id>.hex", "before": "#ad1a2d", "after": "#a51829" }]
--
-- Nullable on purpose: rows published before this column existed have no
-- entries, and the UI falls back to the flat `changelog` text for those.
--
-- Human-gated (do not auto-apply).

alter table public.brand_canon_versions
  add column if not exists change_entries jsonb;
