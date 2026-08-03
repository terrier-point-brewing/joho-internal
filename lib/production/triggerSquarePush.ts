// lib/production/triggerSquarePush.ts
//
// Restate a recipe's Square counts right after its cold storage changed.
//
// The daily push is the backstop; this is what keeps the taproom's numbers
// current between runs, so a packaging run shows up in Square within seconds
// instead of the next morning.
//
// NO-OPS WHILE THE PUSH GATE IS SHUT. The measurement costs Square API calls,
// and spending them on a correction nobody will send is pure waste — so the
// trigger checks the gate before doing any work rather than after. When the gate
// opens these call sites become live with no further change.
//
// Never throws: an inventory movement must not fail because Square was slow or
// unreachable. The daily job re-covers anything a dropped trigger missed, which
// is the same contract the taproom consumption sync already relies on.

import type { SupabaseClient } from "@supabase/supabase-js";
import { pushInventoryToSquare } from "./pushInventoryToSquare";
import { PUSH_TO_SQUARE_ENABLED } from "@/lib/square/pushGate";

export async function triggerSquarePush(
  supabase: SupabaseClient,
  recipeIds: (string | null | undefined)[],
  context: string,
): Promise<void> {
  if (!PUSH_TO_SQUARE_ENABLED) return;

  const ids = [...new Set(recipeIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return;

  try {
    const result = await pushInventoryToSquare(supabase, { recipeIds: ids });
    if (result.warnings.length > 0) {
      console.warn(`[square-push] ${context}`, { recipeIds: ids, warnings: result.warnings });
    }
  } catch (e) {
    console.error(`[square-push] ${context} failed`, e);
  }
}
