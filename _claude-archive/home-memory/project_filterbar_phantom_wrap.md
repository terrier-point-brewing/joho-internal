---
name: project_filterbar_phantom_wrap
description: "SearchInput's width:100% gave FilterBar rows no definite flex basis, wrapping filters onto a second line with hundreds of px of free space"
metadata: 
  node_type: memory
  type: project
  originSessionId: 33b169f8-febb-41e0-a7e3-67080a52b92a
  modified: 2026-07-29T02:27:53.224Z
---

2026-07-28, **PR #288 MERGED** (squash `e440aac`). No migration — presentation only. Worktree + branch removed.

`.inp-sm` (app/globals.css) sets `width: 100%`. `SearchInput` layered `max-w-xs` on top, so inside `FilterBar` (a shrink-to-fit flex item) the input had **no definite flex basis**: the row's max-content contribution was computed against the input's ~171px *intrinsic* width, then the input resolved its `width:100%` against the now-definite row width and rendered at 320px — overflowing the box that was just sized for it and wrapping the sibling filter chips to a second line.

Measured on Stock Adjustments at a 1440px viewport: outer row 1392px, FilterBar sized to 503.8px, children needed 660.3px. Hundreds of px of free space, yet it wrapped.

Fixed by pinning a real basis in `SearchInput`: `inp-sm w-64 max-w-full` (`max-w-full` keeps it shrinkable inside modals). Shared fix — all 18 `<SearchInput>` call sites were susceptible to the same latent wrap.

Same PR: new shared `app/components/ui/ToggleChip.tsx` (one definition of the chip look; `FilterChips` composes it, Stock Adjustments' hand-rolled "Group by Day" button now uses it); FilterBar's Clear → `.btn-xxs`; Ingredients/Packaging action rows given `min-w-32` for equal widths and a consistent `btn-primary` Bulk Receive.

**Why:** a percentage width inside a shrink-to-fit flex container is circular; the browser resolves it in two passes and the second pass overflows the first. Nothing looks wrong in the markup.
**How to apply:** when a flex row wraps despite obvious free space, measure the container width vs. the summed child widths in the browser before touching the markup — don't add `flex-wrap`/`shrink-0` guesses. Suspect any child whose width comes from a `width:100%` component class.

Related: [[project_text_ramp_utilities_tailwind_v4.md]] — another case where the class list read correctly but the computed style was the only way to see the bug.
