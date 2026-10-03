---
name: project_draft_swap_tap_transitions
description: "2026-07-25 - beer-changing draft swaps now book both sides via frozen tap_swap_transitions; PR #269 MERGED, migration 20260816 APPLIED"
metadata: 
  node_type: memory
  type: project
  originSessionId: f741416e-c905-434a-8dd1-95a51e3a7a04
  modified: 2026-07-25T15:10:28.771Z
---

Beer-changing draft swaps (tap goes Beer A → Beer B) previously could only express ONE recipe, because a Draft Restock ring resolved against mutable `tap_assignments` (keyed by `tap_number`, no history). Two real bugs: the outgoing beer's Square draft SKU was never zeroed (kept leftover fl oz forever while on no tap, inflating draft on-hand), and the outgoing keg's shrinkage was filed against the INCOMING beer because the capture read `u.recount.squareVariationId`.

Fix = new `tap_swap_transitions` table holding a **frozen snapshot of both sides** (recipes, variations, coded volumes, Square draft SKU ids), opened by an explicit **Swap keg** action on Draft Stats. Configure Taps stays a corrections-only path that never opens one. The ring claims the transition and books: residual → shrinkage against the OUTGOING recipe, zero outgoing SKU, deduct INCOMING keg, recount INCOMING SKU to full, un-retire incoming, flip the tap.

**PR #269 MERGED (squash) 2026-07-25, merge commit 92e1bbd. Migration 20260816 APPLIED (verified: table returns `[]` not PGRST205).** Green at merge: 1903 tests.

Durable gotchas worth remembering:

- **The draft SKU is per RECIPE, not per tap.** So a beer on two taps cannot have its level written off or zeroed on one of them — the count is the combined level. Guarded by a `multi_tap_outgoing_skipped` discrepancy. Same root cause as `byRecipe` in the draft-stats route collapsing two taps of one beer into one metric. Any future per-tap draft work hits this wall first.
- **`tap_assignments` is deliberately NOT updated when a swap is queued** — the ring flips it. That's what keeps the card showing what is physically pouring when a rotation is planned a day ahead.
- **Retire fires at queue time, un-retire at ring time.** `retire_outgoing` is true only if that transition actually flipped the flag, so cancelling can't un-retire a beer that was already retired. See [[project_draft_swap_keg_generic_options]] for the keg-dropdown/on-hand history.
- **Workflow assumption: config-first.** Taps are reconfigured in the app BEFORE the bartender rings. Ring-first is explicitly unhandled — it books a like-for-like against current config.

Open follow-ups:

- **The mandatory final whole-branch review never ran** (user cancelled it, then merged). The concurrency path is untested outside my own mocks: the conditional claim is NOT in a transaction with the writes that follow it, so a mid-sequence failure can leave a claimed-but-half-booked swap. Worth a dedicated look. See [[feedback_final_review_catches_real_bugs]].
- **No reversal path** for swaps already booked wrong under the old behavior — historical `export_transactions` / `draft_swap_shrinkage` rows are uncorrected.
- Pre-existing, unrelated: hydration mismatch on `<html data-theme>` in RootLayout (brand-skin toggle).
