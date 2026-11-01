#!/usr/bin/env -S node --import tsx --env-file=.env.local
/**
 * Work in Process (GL 1250) as it stood at the end of a day, rebuilt from the
 * batch transfer history. Used to backfill the months before the shelf
 * existed (it went live 2026-10-09), so the P&L's inventory-change row can
 * see tank beer move month to month instead of meeting it all at once.
 *
 * Prints only. Writing the snapshot is a separate, deliberate step.
 *
 * Run: npx tsx --env-file=.env.local scripts/wip-as-of.ts 2026-07-31 2026-08-31 2026-09-30
 */
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadBatchCosts, workInProcessCents } from "@/lib/finance/batchCost";

const dates = process.argv.slice(2);
if (dates.length === 0 || dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
  console.error("usage: wip-as-of.ts YYYY-MM-DD [YYYY-MM-DD ...]");
  process.exit(1);
}

async function main() {
  const supabase = createSupabaseAdminClient();
  for (const asOf of dates) {
    const costs = await loadBatchCosts(supabase, asOf);
    const inTank = [...costs.entries()].filter(([, c]) => c.wipCents > 0);
    console.log(`\n${asOf}  WIP ${(workInProcessCents(costs) / 100).toFixed(2)}  (${inTank.length} batches in tank)`);
    for (const [id, c] of inTank) {
      console.log(`  ${id}  inTank ${c.inTankBbl.toFixed(2)} bbl  packaged ${c.packagedBbl.toFixed(2)}  wip ${(c.wipCents / 100).toFixed(2)}`);
    }
  }
  const live = await loadBatchCosts(supabase);
  console.log(`\nlive       WIP ${(workInProcessCents(live) / 100).toFixed(2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
