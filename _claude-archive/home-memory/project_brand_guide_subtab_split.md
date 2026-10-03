---
name: project_brand_guide_subtab_split
description: "2026-07-24 Brand Guide reorganization — single Guide subtab split into Ethos/Voice/Visual Identity/Agent Rules, per-slice edit facets, naming/tap-list dropped from guide"
metadata: 
  node_type: memory
  type: project
  originSessionId: 114afe35-a2a9-492b-b95e-e2cdd65892d1
  modified: 2026-07-24T19:46:05.656Z
---

2026-07-24: Reorganized the Brand Guide (`app/brand/guide/`). The one narrative **Guide** subtab (`GuideNarrative` + `GuideToc`, deleted) was split into **four** content subtabs, each a single-`GuideSection` view matching the Color/Type layout: **Ethos** (mission+missionNarrative+values, merged with NO sub-headers), **Voice** (voice), **Visual Identity** (illustrationLaw — meant to grow to cover all visual identity), **Agent Rules** (neverList+precedence+hardRules; explicitly machine-facing, future home for full Markdown brand instructions). Tab order: Ethos·Voice·Visual Identity·Agent Rules·Color·Type·Marks·(History). Default active tab = `ethos`.

**Edit structure — "broke apart the canon JSON blob" WITHOUT a schema/DB migration** (user chose flat-schema option). The monolithic `ContentFacet` (one giant JSON textarea over all prose) was deleted and replaced by a generic reusable `app/brand/canon/facets/SliceJsonFacet.tsx` + shared slice defs in `canonSlices.ts` (ethosSlice/voiceSlice/visualSlice/agentSlice/colorForbiddenSlice — each a `canonSchema.pick()` + key list). `CanonEditor` (`CanonSection` type now `ethos|voice|visual|agent|color|type|marks`) renders each tab's own slice. `colorForbidden` editing moved to the **Color** tab (rendered there in ColorView). Three hard-coded section lists kept in sync: `BrandGuideTabs` (TabKey/CANON_SECTIONS/tabs), `CanonEditor` (CanonSection + switch), the slice defs.

⚠️ **`naming` was NOT deleted from the canon** even though the user first said "drop naming completely." Surfaced that `canon.naming` powers the **Releases naming-check** (`app/brand/releases/LabelsWorkbench.tsx` + `releases/page.tsx:15`) and the **agent brief** (`lib/brand/brief.ts:50`). User's revised call: naming "moves to Releases completely" (Releases will be reworked into templated release components later). So `naming` stays in `canon.schema.ts`/`seedCanon`/tests UNCHANGED — it just left the guide's display + edit surface. Net: **zero canon schema/seed change**; the whole task is pure guide UI.

**Tap list** (approved labels showcase) dropped from the guide entirely; the `resolveApprovedLabels` labels fetch removed from `guide/page.tsx` (labels module untouched for Releases).

**Editor gap (intentional, transitional):** `naming`, `chop`, `labelChassis`, `visibility` were only ever editable via the deleted `ContentFacet`. They keep their stored values (readers still work) but now have NO UI editor — their editing is deferred to their owning modules' future rework (naming/labelChassis→Releases, chop→Marks/Releases, visibility→Phase-5 public site). Flag if an admin needs to edit these before then.

Verify GREEN: typecheck clean, 1845 tests pass, 0 lint errors. Browser-verified all 4 view tabs + Ethos/Agent Rules edit facets scoped correctly. Branch `claude/brand-guide-reorganization-b568c3` (worktree), NOT committed/PR'd yet. Related: [[project_brand_design_system]].
