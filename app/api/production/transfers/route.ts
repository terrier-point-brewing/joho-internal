import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const { searchParams } = new URL(req.url);
  const batch_id = searchParams.get("batch_id");

  let query = supabase
    .from("batch_transfers")
    .select("*, from_tank:from_tank_id(id, name, type), to_tank:to_tank_id(id, name, type), to_batch:to_batch_id(id, beer_name, batch_number)")
    .order("transferred_at", { ascending: false });

  if (batch_id) query = query.eq("batch_id", batch_id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const {
    batch_id,
    from_tank_id,
    to_tank_id,
    volume_bbl,
    shrinkage_bbl,
    transfer_type,
    notes,
    kegging_detail,
    canning_detail,
  } = body;

  // Capacity guard: reject before hitting the RPC if destination is a
  // constrained tank and the transfer volume exceeds its capacity_bbl.
  if (to_tank_id && volume_bbl != null) {
    const { data: destTank } = await supabase
      .from("equipment")
      .select("capacity_bbl, type")
      .eq("id", to_tank_id)
      .single();
    const UNCONSTRAINED = new Set(["kegging", "canning", "cold_storage", "backlog", "loading_bay", "export_bay"]);
    if (destTank && !UNCONSTRAINED.has(destTank.type) && destTank.capacity_bbl != null) {
      if (volume_bbl > destTank.capacity_bbl) {
        return NextResponse.json(
          { error: `Transfer volume (${volume_bbl} BBL) exceeds destination capacity (${destTank.capacity_bbl} BBL).` },
          { status: 422 }
        );
      }
    }
  }

  // One transaction: insert transfer, release the old assignment, create the
  // new assignment (constrained destinations only), and roll batch status
  // forward. See record_batch_transfer() — keeps these writes atomic.
  const { data: transfer, error } = await supabase
    .rpc("record_batch_transfer", {
      p_batch_id:       batch_id,
      p_from_tank_id:   from_tank_id  || null,
      p_to_tank_id:     to_tank_id    || null,
      p_volume_bbl:     volume_bbl,
      p_shrinkage_bbl:  shrinkage_bbl ?? 0,
      p_transfer_type:  transfer_type ?? "transfer",
      p_notes:          notes         || null,
      p_kegging_detail: kegging_detail ?? null,
      p_canning_detail: canning_detail ?? null,
    })
    .single();

  if (error) {
    // "Destination tank is already occupied" is a client conflict, not a 500.
    const status = error.message.includes("already occupied") ? 409 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  // ── Packaging deduction ───────────────────────────────────────────────────
  // When kegging or canning product arrives in cold storage, consume the
  // packaging items used so inventory stays accurate.
  // Runs after the transfer is committed — failures are logged but don't roll
  // back the transfer, since the DB record is already the source of truth.
  try {
  if (transfer_type === "kegging" && kegging_detail?.kegs?.length) {
    for (const keg of kegging_detail.kegs as { packaging_id?: string; quantity: number }[]) {
      if (!keg.packaging_id || !keg.quantity) continue;
      const { data: pkg } = await supabase
        .from("packaging_items")
        .select("stock_quantity")
        .eq("id", keg.packaging_id)
        .single();
      if (pkg) {
        const newQty = Number(pkg.stock_quantity) - keg.quantity;
        await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", keg.packaging_id);
        await supabase.from("packaging_stock_adjustments").insert({
          packaging_item_id:  keg.packaging_id,
          quantity:           -keg.quantity,
          type:               "used",
          note:               `Kegging — batch ${batch_id}`,
          batch_transfer_id:  (transfer as { id: string }).id,
          cost_per_unit:      null,
          total_value_change: null,
        });
      }
    }
  }

  if (transfer_type === "canning" && canning_detail) {
    const cd = canning_detail as {
      can_packaging_id?: string;
      lid_packaging_id?: string;
      paktech_packaging_id?: string;
      tray_packaging_id?: string;
      label_packaging_id?: string;
      total_cans?: number;
      cases?: number;
      cans_per_case?: number;
    };
    const totalCans = cd.total_cans ?? 0;
    const cases     = cd.cases ?? 0;

    const deductions: { id: string | undefined; qty: number; label: string }[] = [
      { id: cd.can_packaging_id,     qty: totalCans, label: "cans" },
      { id: cd.lid_packaging_id,     qty: totalCans, label: "lids" },
      { id: cd.label_packaging_id,   qty: totalCans, label: "labels" },
      { id: cd.tray_packaging_id,    qty: cases,     label: "trays" },
    ];

    if (cd.paktech_packaging_id) {
      const { data: ptItem } = await supabase
        .from("packaging_items")
        .select("can_count")
        .eq("id", cd.paktech_packaging_id)
        .single();
      const paktechCount = Math.ceil(totalCans / Math.max(1, ptItem?.can_count ?? 4));
      deductions.push({ id: cd.paktech_packaging_id, qty: paktechCount, label: "paktechs" });
    }

    for (const d of deductions) {
      if (!d.id || !d.qty) continue;
      const { data: pkg } = await supabase
        .from("packaging_items")
        .select("stock_quantity")
        .eq("id", d.id)
        .single();
      if (pkg) {
        const newQty = Number(pkg.stock_quantity) - d.qty;
        await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", d.id);
        await supabase.from("packaging_stock_adjustments").insert({
          packaging_item_id:  d.id,
          quantity:           -d.qty,
          type:               "used",
          note:               `Canning (${d.label}) — batch ${batch_id}`,
          batch_transfer_id:  (transfer as { id: string }).id,
          cost_per_unit:      null,
          total_value_change: null,
        });
      }
    }
  }

  // brew_batches.volume_bbl is the ORIGINAL brew volume and must not be mutated
  // by transfers — the transfer ledger (batch_transfers) is the source of truth
  // for current per-tank volumes.
  } catch (deductionErr) {
    console.error("[transfers] Packaging deduction failed (transfer committed):", deductionErr);
  }

  // ── Schedule reconciliation ───────────────────────────────────────────────
  // When beer arrives in a fermenter or brite (conditioning) tank, update or
  // create the matching schedule entry so actuals are recorded.
  // When beer leaves a fermenter or brite and the tank drains, close out the entry.
  const RECONCILE_TYPES = new Set(["fermenter", "brite"]);
  // Maps equipment.type → stage key stored in batch_schedule_entries
  const EQ_TYPE_TO_STAGE: Record<string, string> = { fermenter: "fermenter", brite: "conditioning" };

  const scheduleUpdate: {
    action: string;
    entry_id: string;
    equipment_name?: string;
    was_deviation?: boolean;
  }[] = [];

  // 1. Handle arrival (to_tank is fermenter or brite)
  if (to_tank_id) {
    const { data: destTankInfo } = await supabase
      .from("equipment")
      .select("id, name, type")
      .eq("id", to_tank_id)
      .single();

    if (destTankInfo && RECONCILE_TYPES.has(destTankInfo.type)) {
      const targetStage = EQ_TYPE_TO_STAGE[destTankInfo.type];
      const today = new Date().toISOString().split("T")[0];

      // Look for an existing uncancelled entry for this batch+stage
      const { data: existingEntries } = await supabase
        .from("batch_schedule_entries")
        .select("id, equipment_id, planned_start, planned_end, actual_start, actual_end")
        .eq("batch_id", batch_id)
        .eq("stage", targetStage)
        .is("cancelled_at", null)
        .order("planned_start", { ascending: true })
        .limit(1);

      const existing = existingEntries?.[0];

      if (existing) {
        if (existing.equipment_id === to_tank_id) {
          // Same tank as planned — just stamp actual_start
          await supabase
            .from("batch_schedule_entries")
            .update({ actual_start: today, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
          scheduleUpdate.push({ action: "actual_start_set", entry_id: existing.id, equipment_name: destTankInfo.name, was_deviation: false });
        } else {
          // Different tank — cancel the original and create a new entry for the actual tank
          const durationMs = new Date(existing.planned_end).getTime() - new Date(existing.planned_start).getTime();
          const durationDays = Math.max(1, Math.round(durationMs / 86400000));
          const newEnd = new Date(Date.now() + durationDays * 86400000).toISOString().split("T")[0];

          await supabase
            .from("batch_schedule_entries")
            .update({ cancelled_at: new Date().toISOString(), cancellation_reason: `Batch transferred to ${destTankInfo.name} instead`, updated_at: new Date().toISOString() })
            .eq("id", existing.id);

          const { data: newEntry } = await supabase
            .from("batch_schedule_entries")
            .insert({ batch_id, equipment_id: to_tank_id, stage: targetStage, planned_start: today, planned_end: newEnd, actual_start: today, notes: `Auto-created: deviation from planned equipment` })
            .select("id")
            .single();

          scheduleUpdate.push({ action: "deviation_rebooked", entry_id: newEntry?.id ?? "", equipment_name: destTankInfo.name, was_deviation: true });
        }
      } else {
        // No entry existed — create one
        const defaultDays = targetStage === "fermenter" ? 14 : 21;
        const newEnd = new Date(Date.now() + defaultDays * 86400000).toISOString().split("T")[0];
        const { data: newEntry } = await supabase
          .from("batch_schedule_entries")
          .insert({ batch_id, equipment_id: to_tank_id, stage: targetStage, planned_start: today, planned_end: newEnd, actual_start: today, notes: `Auto-created on transfer` })
          .select("id")
          .single();
        scheduleUpdate.push({ action: "created", entry_id: newEntry?.id ?? "", equipment_name: destTankInfo.name, was_deviation: false });
      }
    }
  }

  // 2. Handle departure (from_tank is fermenter or brite AND tank drains to zero)
  if (from_tank_id) {
    const { data: srcTankInfo } = await supabase
      .from("equipment")
      .select("id, name, type")
      .eq("id", from_tank_id)
      .single();

    if (srcTankInfo && RECONCILE_TYPES.has(srcTankInfo.type)) {
      // We'll compute remaining volume AFTER this transfer using the full ledger
      const { data: allLedger } = await supabase
        .from("batch_transfers")
        .select("from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl")
        .eq("batch_id", batch_id)
        .or(`from_tank_id.eq.${from_tank_id},to_tank_id.eq.${from_tank_id}`);

      const netInSrc = (allLedger ?? []).reduce((sum, row) => {
        if (row.to_tank_id === from_tank_id) return sum + Number(row.volume_bbl);
        if (row.from_tank_id === from_tank_id) return sum - Number(row.volume_bbl) - Number(row.shrinkage_bbl ?? 0);
        return sum;
      }, 0);

      if (netInSrc <= 0.001) {
        // Tank is drained — close out the active schedule entry
        const sourceStage = EQ_TYPE_TO_STAGE[srcTankInfo.type];
        const today = new Date().toISOString().split("T")[0];

        const { data: activeEntries } = await supabase
          .from("batch_schedule_entries")
          .select("id")
          .eq("batch_id", batch_id)
          .eq("stage", sourceStage)
          .eq("equipment_id", from_tank_id)
          .is("cancelled_at", null)
          .is("actual_end", null)
          .limit(1);

        const activeEntry = activeEntries?.[0];
        if (activeEntry) {
          await supabase
            .from("batch_schedule_entries")
            .update({ actual_end: today, updated_at: new Date().toISOString() })
            .eq("id", activeEntry.id);
          scheduleUpdate.push({ action: "actual_end_set", entry_id: activeEntry.id, equipment_name: srcTankInfo.name });
        }
      }
    }
  }

  // Partial-transfer: the RPC always releases the from_tank assignment, but if
  // volume remains in the source tank we need to re-insert the assignment so the
  // floorplan tile keeps showing the batch there.
  //
  // Compute remaining volume from the ledger rather than brew_batches.volume_bbl
  // so that chains of prior partial draws are accounted for correctly.
  if (from_tank_id) {
    const { data: ledgerRows } = await supabase
      .from("batch_transfers")
      .select("from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl")
      .eq("batch_id", batch_id)
      .or(`from_tank_id.eq.${from_tank_id},to_tank_id.eq.${from_tank_id}`);

    const netInTank = (ledgerRows ?? []).reduce((sum, row) => {
      if (row.to_tank_id   === from_tank_id) return sum + Number(row.volume_bbl);
      if (row.from_tank_id === from_tank_id) return sum - Number(row.volume_bbl) - Number(row.shrinkage_bbl ?? 0);
      return sum;
    }, 0);

    if (netInTank > 0.001) {
      const { error: reassignErr } = await supabase
        .from("batch_tank_assignments")
        .insert({ batch_id, tank_id: from_tank_id });
      // 23505 = active assignment already exists (acceptable for in-progress partial transfers).
      if (reassignErr && reassignErr.code !== "23505") {
        return NextResponse.json({ error: reassignErr.message }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ transfer, schedule_update: scheduleUpdate }, { status: 201 });
}
