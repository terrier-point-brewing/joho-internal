---
name: project_ghost_duplicate_packaging_variation_links
description: "2026-07-16 \"duplicate Fortnight - 1/2 Keg\" was a ghost recipe-link to an inactive variation; fixed via is_active filter (PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: acdff422-0789-45fb-8980-8f19fe865493
---

2026-07-16: User reported "duplicate Fortnight - 1/2 Keg" packaging variations. Root cause: only ONE active `Fortnight - 1/2 Keg` exists (`478d840d`); the "duplicate" was a **ghost** — superseded variations are soft-deleted (`is_active=false`) but their `recipe_packaging_variations` links linger. The **Vienna Lager** recipe (an Argus recipe, `78b42b64`) was linked to both the active variation and the inactive near-identically-named `Fortnight 1/2 Keg` (no dash, `0ea5229b`), and `GET /api/production/recipe-packaging-variations` returned links regardless of `is_active`.

**Fix (PR #212, MERGED to main `5dee7f7`; worktree+branch cleaned up):** shared recipe-links API now filters the embedded variation with `packaging_variations!inner(...)` + `.eq("packaging_variations.is_active", true)`. `!inner` is required so the parent link row is dropped, not just the embed nulled. Benefits all consumers: Recipes tab, kegging/canning dropdowns (`TransferModal`), `BrewStatusTab`, `CommitmentsTab` — none should offer/display an inactive variation. Verified live: 69 active links vs 70 total.

**STILL PENDING (manual, human-gated):** the orphaned link row is only hidden, not deleted. Claude Code's auto-mode classifier blocks direct prod-DB writes and Supabase MCP is unauthorized in non-interactive sessions, so the user must run:
```sql
delete from recipe_packaging_variations
where variation_id = '0ea5229b-ac83-4923-ace1-79d8bd8d5a21'; -- inactive "Fortnight 1/2 Keg" → Vienna Lager
```

**Also noted, NOT fixed (user scoped to hide-only):** the *active* `Fortnight - 1/2 Keg` (partner=Fortnight) is still linked to the **Vienna Lager** recipe whose `partner_id` is **Argus** (`ddc85be3`) — a likely cross-partner mislink (link row `7d9d2277`). Same tangle: Vienna Lager also carries `Fortnight Carolina Amber Ale` can links. Seed-data naming/partner mess from migration `20260627_printed_can_and_partner_kegs` / `20260627_migrate_keg_transfers`. See [[project_packaging_variations_breaks_into_embed]] for related self-ref-embed history on this same panel.
