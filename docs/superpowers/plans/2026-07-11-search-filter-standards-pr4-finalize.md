# Search / Filter / Sort Standards — PR 4 (Finalize) Implementation Plan

**Goal:** Close out the sweep: retire the legacy `SortControls.tsx`, reshell PartnersTab's server-side search on the shared `SearchInput` (adding an `autoFocus` prop), refine the enforcement guard to stop false-positiving on server-side API routes, and flip the guard to **blocking** (`--strict`) in CI. Taproom remainder is confirmed out of scope (all data-window selectors / config editors — no filter/sort surfaces).

**Architecture:** No new patterns. Removes the last legacy artifact, extends one primitive with an additive prop, and hardens the CI guard now that all UI surfaces are on the standard.

## Global Constraints
- Base branch `claude/search-filter-retrofit-pr4` off `origin/main` (PR 2 #159 + PR 3 #162 are merged; `SortControls.tsx` has **0 importers** on main — verified).
- Additive/backward-compatible only. Guard changes must not affect legitimate UI flags.
- **Order matters:** refine the guard AND delete SortControls BEFORE flipping to `--strict`, or the strict run fails on the 2 API false-positives + the SortControls self-flag.
- Gate each step: `tsc --noEmit`, `build`, `lint`, `test`, and `check:search-filter` (`--strict` must exit 0 by the end).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Tasks

### Task 1: Retire legacy SortControls + harden the guard + flip to strict
**Files:** delete `app/reports/components/SortControls.tsx`; modify `scripts/check-search-filter.mjs`, `package.json`, `.github/workflows/ci.yml`.

1. **Verify 0 importers:** `grep -rn "reports/components/SortControls" app/` → nothing. Then `git rm app/reports/components/SortControls.tsx`. (If the `app/reports/components/` dir is now empty, leave any siblings; only remove the one file.)
2. **Refine the guard** (`scripts/check-search-filter.mjs`): give the `.toLowerCase().includes(` rule a per-rule path skip so it does NOT flag `app/api/**` server-side route handlers (those aren't UI). Add `skipPath: /^app[/\\]api[/\\]/` to that rule object, compute `const relFile = relative(ROOT, file)` once per file in the scan loop, and `if (rule.skipPath && rule.skipPath.test(relFile)) continue;` before testing the line. Leave the other three rules unchanged (whole-`app/components/ui` exclusion still applies to all).
3. **Confirm clean:** `node scripts/check-search-filter.mjs` → `✓ no violations` (the 2 API routes skipped, SortControls deleted).
4. **Flip CI to blocking:** in `.github/workflows/ci.yml`, change the guard step to `npm run check:search-filter -- --strict` and rename it from "(warn-only)" to "Search/filter standard". Optionally add `"check:search-filter:strict"` to `package.json`. Verify `node scripts/check-search-filter.mjs --strict; echo $?` prints `0`.
5. Gate (`tsc`/`lint`/`test`/`build`) + commit `chore(ci): retire legacy SortControls, exclude api routes from guard, flip to strict`.

### Task 2: SearchInput autoFocus + PartnersTab server-search reshell
**Files:** modify `app/components/ui/SearchInput.tsx`, `app/production/components/PartnersTab.tsx`.

1. **Add an additive `autoFocus?: boolean` prop** to `SearchInput` (default undefined/false), forwarded to the underlying `<input autoFocus={autoFocus}>`. No other behavior change.
2. **Reshell the `SquareImportModal` search input** in PartnersTab: replace the raw `<input className="inp" placeholder="Name, company, or email…" value={query} onChange={handleQueryChange} autoFocus />` with `<SearchInput value={query} onChange={(v) => { setQuery(v); setSelected(null); fetchContacts(v); }} placeholder="Search by name, company, or email…" debounceMs={350} autoFocus />`. Remove the now-unused `handleQueryChange` + `debounceRef` (SearchInput owns the debounce). Keep `fetchContacts`, the mount `fetchContacts("")`, the results list, loading/empty states, and the server-side `/api/square/contacts` path unchanged.
   - **Accepted minor:** `setSelected(null)`/`setQuery` now fire on the debounced tick rather than each keystroke (SearchInput shows typed text immediately via its own internal state, so the box stays responsive). Behavior-equivalent for the user.
3. Gate + `npm run check:search-filter -- --strict` (must stay 0) + commit `refactor(production): reshell Partners Square-search on shared SearchInput (+autoFocus)`.

## Definition of Done
- [ ] `SortControls.tsx` deleted; `grep -rn useSort\|"SortControls"` finds nothing in `app/`.
- [ ] `node scripts/check-search-filter.mjs --strict` exits **0** (no violations); CI step runs it with `--strict`.
- [ ] `tsc` clean, `lint` 0 errors, `test` green, `build` ok.
- [ ] PartnersTab modal search still works server-side (debounced, autofocused); the standard now has zero known unretrofitted UI surfaces.
- [ ] Browser (controller): Partners → Import from Square modal autofocuses + searches; each already-retrofitted area unaffected.

## Sweep complete after this PR
PR 0 (#139) foundation · PR 1 (#154) named-four · PR 2 (#159) rest-of-production · PR 3 (#162) finance-transactions · PR 4 (this) finalize. Out of scope by design: finance payroll/settings/model/sales/statements + taproom data-window tabs (no filter/sort divergence); Orders server-side search is a tracked follow-up.
