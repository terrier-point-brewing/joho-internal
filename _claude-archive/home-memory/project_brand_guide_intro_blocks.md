---
name: project-brand-guide-intro-blocks
description: 2026-07-25 Brand Guide subtab org changes — editable per-subtab intro blocks in canon.guideIntros; migration 20260818 PENDING prod apply
metadata: 
  node_type: memory
  type: project
  originSessionId: 7ca78363-6f82-4c83-a1f1-b4c499a60959
  modified: 2026-07-25T16:09:53.864Z
---

2026-07-25, branch `claude/brand-tab-org-changes-db4840` (worktree `rls-policy-recipe-square-link-b92024`). Brand Guide organizational pass, building on [[project-brand-guide-subtab-split]]:

- Per-subtab headings removed (the subtab label already names the section); divider rule under the lead removed.
- The lead became a **generic editable introduction block** stored at `canon.guideIntros.<subtab>` (`ethos|voice|visual|color|type|marks|agent`), edited via a plain textarea (`IntroFacet`) mounted on every subtab's editor — NOT through the JSON blob. Blank line = new paragraph.
- Tab order now Ethos · Voice · Visual Identity · Color · Type · Marks · Agent Rules.
- **Fields removed from the canon schema:** `mission`, `missionNarrative`, `voice.summary`, `voice.personality`, `illustrationLaw.narrative`. Their prose moved into `guideIntros`. Founder explicitly said drop the one-line `mission` ("we don't need it right now").

**⚠️ Migration `20260818_brand_canon_guide_intros.sql` is PENDING prod apply** (human-gated). It rewrites `brand_canon_versions.document` for `draft` + `published` rows only — archived rows are left as historical snapshots. Verified against the real prod document on a throwaway local Postgres: idempotent over 3 runs, and a pre-existing `guideIntros` edit wins over the rebuilt values. Not required for correctness — `resolveGuideIntro` falls back to `seedCanon` per subtab, so the guide renders identically before and after; the migration is what makes the DB (not code) the source of truth.

**Durable gotchas:**
- `getCanon()` does NOT zod-parse the published row — it casts. Only `saveDraft`/`publishDraft` parse, and `z.object` **strips** unknown keys. So removing a canon field is backward-compatible: stale keys survive in the DB until the next save, then vanish silently.
- `canon.visibility` is `z.record(enum, …)` = **exhaustive**. Its `"mission"` key was deliberately kept in `sectionKeySchema` even though the field is gone — dropping it would fail validation on every stored document until all are rewritten. Loose end for Phase 5.
- Live published canon as of this work: **v1.2, published 2026-07-24**. Its `missionNarrative` / `voice.summary` / `voice.personality` / `illustrationLaw.narrative` were byte-identical to `seedCanon`, so nothing was lost in the move.
- `resolveGuideIntro` is the single resolver — guide views, `IntroFacet`, `BrandPreview`, `/brand/preview`, and `compileAgentBrief` all read through it, so the guide and the agent brief can't drift.

**PR #274 OPEN** (rebased on #272 + #273; green at 1985 tests). Migration prefix bumped 20260817 -> 20260818 because #272 landed `20260817_export_invoice_material_components.sql` on main first — see [[project-draft-swap-tap-transitions]] for the collision gotcha. Browser E2E unverified — `/brand/guide` is behind the login gate.
