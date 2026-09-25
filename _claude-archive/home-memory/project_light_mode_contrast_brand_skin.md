---
name: project-light-mode-contrast-brand-skin
description: 2026-07-23 systemic fix for light-mode contrast bugs under the brand skin — new --cat-* category token system + status-ramp flip
metadata: 
  node_type: memory
  type: project
  originSessionId: bd206746-a6f9-4a5f-ac0b-08a90c0b3e3c
  modified: 2026-07-24T02:07:06.545Z
---

2026-07-23: Fixed 7 light-mode + brand-skin contrast bugs (channel pills, deposit-paid card, stockout warnings, demand calendar, floorplan dark-on-dark, React Flow dark canvas, export-bay pills) with a systemic root-cause fix, not per-instance patches. Branch `claude/light-mode-contrast-brand-skin-e8ac89`, 19 files, `npm run verify` green (1825 tests). Related: [[project_brand_design_system]].

**Two root causes, both systemic:**
1. Status tokens (danger/success/info) were deliberately excluded from the brand light remap in `lib/brand/opsThemeMap.ts` → stayed dark-tuned (`-400` text on `-950` surface) in light mode. Fix: `opsChromeOverrideCss` now emits STATUS_LIGHT/STATUS_DARK ramps (light = `-700` text on `-50`/`-100` tint; dark = original @theme values re-asserted). Status keeps its hue but flips lightness.
2. App-wide category badge convention `bg-{hue}-900/50 text-{hue}-300` + hardcoded canvas hex are raw Tailwind, invisible to the theme system. Fix: new **`--cat-{hue}-{bg,fg,bd}` token family** (14 hues incl. stone) — dark defaults in `app/globals.css :root`, light values emitted by BrandChrome via `CAT_RAMP` in `opsThemeMap.ts`. Shared maps (`categoryColors.ts` CATEGORY_BADGE_CLASS/CHANNEL_COLOR/KEG_TAG_BADGE, `EquipmentSchedule/constants.ts`, `equipmentMeta.ts`) rewritten to `bg-[var(--cat-*-bg)]` etc. Components that bypass shared palettes converted: DemandCalendarTab, BrewStatusTab floorplan (inline `rgba(9,9,11,…)`→`color-mix(var(--color-surface)…)`), NextPlannedBox, EquipmentSchedule nodes/buildGraphData; React Flow `colorMode="dark"`→`colorMode={useBrandTheme()}` + `Background color="var(--color-line-strong)"`.

**Key invariant:** light values live ONLY inside the brand-chrome `<style>` (present only when brand skin on) → the default dark ops app is never regressed. Verified dark-mode token parity (cat-purple-bg = purple-900@50%, danger = red-400, etc.).

**⚠️ CRITICAL Tailwind v4 gotcha:** Tailwind v4 only emits a palette var to `:root` (`--color-red-100` etc.) when some utility class actually USES that step. The token rewrite removed most raw `bg-{hue}-900` usages, so `var(--color-{hue}-100)` / `-800` / even `-900` resolve to EMPTY. Category tokens therefore use **literal baked hexes** (see CAT_RAMP + globals.css comment), NOT `var(--color-{hue}-{step})`. Confirmed empirically: `getComputedStyle(documentElement).getPropertyValue('--color-red-100')` returned `""`.

**Follow-ups (spawned as tasks):** (1) ✅ DONE — `app/finance/financials/channelColors.ts` CHANNEL_COLOR rewritten to `bg-[var(--cat-{hue}-bg)] text-[var(--cat-{hue}-fg)]` + added per-hue `border-[var(--cat-{hue}-bd)]` (chip in FinancialsTable.tsx dropped its hardcoded `border-line-subtle` for `c.border`). taproom→blue, events→teal, contract_brewing→purple, distribution→emerald, wholesale→amber, unknown→neutral surface tokens. Verified in browser: light skin flips catBlue bg #dbeafe / fg #1e40af (dark-on-light, lum 232 vs 65). **Shipped as PR #254 OPEN** on branch `claude/dreamy-leakey-c7b807`, rebased onto main (single commit, no migration). (2) STILL OPEN — `EquipmentSchedule/FlowNode.tsx` is dead code (imported nowhere), near-dup of nodes.tsx with stale raw colors → delete.

The light-mode-contrast branch **PR #252 is MERGED** (squash-merged into main; original commit `3d01838` is NOT an ancestor of main — squash created a new commit). The `--cat-*` tokens are now on main.

Verification note: prod preview is behind a login wall; user logged in for visual checks. Theme is a local cookie (`brand-theme`), brand-skin is a DB `system_settings` toggle already ON in prod — do NOT toggle the DB setting to test; just set the cookie.
