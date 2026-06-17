"use client";

import React, { useState } from "react";
import { Equipment, BrewBatch, PackagingItem, Recipe, UNCONSTRAINED_EQUIPMENT_TYPES } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { EQ } from "../equipmentMeta";
import { fmtBbl2 as fmtBbl } from "@/lib/utils/formatting";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import type { ScheduleEntry } from "../hooks/queries";
import { format, parseISO } from "date-fns";

// Allowed destinations by source equipment type
const DEST_RULES: Partial<Record<string, string[]>> = {
  brewhouse: ["fermenter"],
  fermenter: ["brite", "kegging", "canning", "fermenter"],
  brite:     ["fermenter", "kegging", "canning"],
  kegging:   ["cold_storage", "export_bay"],
  canning:   ["cold_storage", "export_bay"],
};

interface KegLine { packaging_id: string; quantity: string }

// Tank types where only one batch is allowed at a time
const SINGLE_OCCUPANCY_TYPES = new Set(["brewhouse", "fermenter", "brite"]);

interface TransferModalProps {
  batch: BrewBatch;
  fromTank: Equipment;
  allTanks: Equipment[];
  /** IDs of tanks that currently have an active batch assignment */
  occupiedTankIds: Set<string>;
  packaging: PackagingItem[];
  recipes: Recipe[];
  /** Ledger volume currently in fromTank; falls back to batch.volume_bbl if omitted */
  fromTankVolume?: number;
  /** Next planned schedule entry for the next stage of this batch (from batch_schedule_entries) */
  plannedEntry?: ScheduleEntry | null;
  onClose: () => void;
  onDone: (response?: { schedule_update?: { action: string; was_deviation?: boolean; equipment_name?: string }[] }) => Promise<void>;
}

function pkgLabel(p: PackagingItem): string {
  const partner = p.contract_brewing_partners?.company_name ?? null;
  return partner ? `${p.name} (${partner})` : p.name;
}

export default function TransferModal({ batch, fromTank, allTanks, occupiedTankIds, packaging, recipes, fromTankVolume, plannedEntry, onClose, onDone }: TransferModalProps) {
  const [mode, setMode] = useState<"transfer" | "convert">("transfer");

  const allowed = DEST_RULES[fromTank.type] ?? [];
  const destTanks = allTanks.filter((t) => {
    if (t.id === fromTank.id) return false;
    if (!allowed.includes(t.type)) return false;
    // For conversions, destination must be a free fermenter
    if (mode === "convert") return t.type === "fermenter" && !occupiedTankIds.has(t.id);
    // Single-occupancy: exclude tanks that already hold a batch
    if (SINGLE_OCCUPANCY_TYPES.has(t.type) && occupiedTankIds.has(t.id)) return false;
    return true;
  });

  const defaultKegIds = packaging.filter((p) => p.type === "keg" && p.is_default).map((p) => p.id);
  const [kegLines, setKegLines] = useState<KegLine[]>(
    defaultKegIds.length > 0
      ? defaultKegIds.map((id) => ({ packaging_id: id, quantity: "" }))
      : [{ packaging_id: "", quantity: "" }]
  );

  const defaultCan     = packaging.find((p) => p.type === "can"     && p.is_default);
  const defaultLid     = packaging.find((p) => p.type === "lid"     && p.is_default);
  const defaultPaktech = packaging.find((p) => p.type === "paktech" && p.is_default);
  const defaultTray    = packaging.find((p) => p.type === "tray"    && p.is_default);
  const defaultLabel   = packaging.find((p) => p.type === "label"   && p.is_default);

  // Pre-select planned destination if the planned entry points to a valid available tank
  const plannedDestId = plannedEntry?.equipment_id ?? null;
  const plannedDestValid = plannedDestId ? destTanks.some((t) => t.id === plannedDestId) : false;
  const [destId,    setDestId]    = useState(plannedDestValid && plannedDestId ? plannedDestId : (destTanks[0]?.id ?? ""));
  const [volumeMode, setVolumeMode] = useState<"full" | "partial">("full");
  const [partialBbl, setPartialBbl] = useState("");
  const [shrinkage,  setShrinkage]  = useState("0");
  const [notes,      setNotes]      = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [canId,     setCanId]     = useState(defaultCan?.id     ?? "");
  const [lidId,     setLidId]     = useState(defaultLid?.id     ?? "");
  const [paktechId, setPaktechId] = useState(defaultPaktech?.id ?? "");
  const [trayId,    setTrayId]    = useState(defaultTray?.id    ?? "");
  const [labelId,   setLabelId]   = useState(defaultLabel?.id   ?? "");
  const [cases,     setCases]     = useState("");
  const [looseCans, setLooseCans] = useState("0");

  // Conversion-specific state
  const [convertRecipeId, setConvertRecipeId] = useState("");
  const [convertBeerName, setConvertBeerName] = useState("");
  const [convertBbl,      setConvertBbl]      = useState("");

  const destTank = allTanks.find((t) => t.id === destId);

  // Recompute destTanks when mode changes — reset destId if current selection is invalid
  const validDestIds = new Set(destTanks.map((t) => t.id));
  const effectiveDestId = validDestIds.has(destId) ? destId : (destTanks[0]?.id ?? "");

  // Whether to show keg/can packaging forms — based on SOURCE type (out-transfers) or DEST type (packaging transfers)
  const showKegDetail = mode === "transfer" && (fromTank.type === "kegging" || destTank?.type === "kegging");
  const showCanDetail = mode === "transfer" && (fromTank.type === "canning" || destTank?.type === "canning");
  const isPackagingForm = showKegDetail || showCanDetail;

  const kegs     = packaging.filter((p) => p.type === "keg");
  const cans     = packaging.filter((p) => p.type === "can");
  const lids     = packaging.filter((p) => p.type === "lid");
  const paktechs = packaging.filter((p) => p.type === "paktech");
  const trays    = packaging.filter((p) => p.type === "tray");
  const labels   = packaging.filter((p) => p.type === "label");

  const selectedTray = packaging.find((p) => p.id === trayId);
  const cansPerCase  = selectedTray?.can_count ?? 0;
  const selectedCan  = packaging.find((p) => p.id === canId);

  const batchVol  = fromTankVolume ?? Number(batch.volume_bbl);
  const shrinkBbl = parseFloat(shrinkage) || 0;

  let drawBbl = 0;
  if (mode === "convert") {
    drawBbl = parseFloat(convertBbl) || 0;
  } else if (showKegDetail) {
    drawBbl = kegLines.reduce((sum, l) => {
      const pkg = packaging.find((p) => p.id === l.packaging_id);
      const qty = parseInt(l.quantity) || 0;
      if (!pkg?.volume_fl_oz) return sum;
      return sum + (qty * pkg.volume_fl_oz) / BBL_TO_FL_OZ;
    }, 0);
  } else if (showCanDetail) {
    const totalCans = (parseInt(cases) || 0) * cansPerCase + (parseInt(looseCans) || 0);
    const canVol    = selectedCan?.volume_fl_oz ?? 0;
    drawBbl = (totalCans * canVol) / BBL_TO_FL_OZ;
  } else if (volumeMode === "full") {
    drawBbl = Math.max(0, batchVol - shrinkBbl);
  } else {
    drawBbl = parseFloat(partialBbl) || 0;
  }

  const totalDraw = drawBbl + (mode === "convert" ? 0 : shrinkBbl);
  const remaining = batchVol - totalDraw;

  const destIsConstrained = destTank && !UNCONSTRAINED_EQUIPMENT_TYPES.includes(destTank.type);

  // Conversion is only available from a fermenter
  const canConvert = fromTank.type === "fermenter";

  function handleModeChange(m: "transfer" | "convert") {
    setMode(m);
    // Reset destination to first valid option for the new mode
    const newDests = allTanks.filter((t) => {
      if (t.id === fromTank.id) return false;
      if (m === "convert") return t.type === "fermenter" && !occupiedTankIds.has(t.id);
      const a = DEST_RULES[fromTank.type] ?? [];
      if (!a.includes(t.type)) return false;
      if (SINGLE_OCCUPANCY_TYPES.has(t.type) && occupiedTankIds.has(t.id)) return false;
      return true;
    });
    setDestId(newDests[0]?.id ?? "");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveDestId) return;

    setSubmitting(true);
    try {
      if (mode === "convert") {
        if (!convertRecipeId || !convertBeerName || !convertBbl) {
          alert("Please fill in all conversion fields.");
          return;
        }
        const res = await fetch("/api/production/conversions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            batch_id:    batch.id,
            from_tank_id: fromTank.id,
            to_tank_id:  effectiveDestId,
            volume_bbl:  parseFloat(convertBbl),
            recipe_id:   convertRecipeId,
            beer_name:   convertBeerName,
            notes:       notes || null,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Error");
        await onDone();
        onClose();
        return;
      }

      // Capacity guard for constrained tanks
      if (destIsConstrained && destTank?.capacity_bbl) {
        if (drawBbl > destTank.capacity_bbl) {
          alert(`Transfer volume (${fmtBbl(drawBbl)}) exceeds ${destTank.name} capacity (${fmtBbl(destTank.capacity_bbl)} BBL).`);
          return;
        }
      }

      let kegging_detail = null;
      let canning_detail = null;
      let transfer_type: "transfer" | "kegging" | "canning" = "transfer";

      if (showKegDetail) {
        transfer_type = "kegging";
        kegging_detail = {
          kegs: kegLines.map((l) => {
            const pkg = packaging.find((p) => p.id === l.packaging_id);
            return {
              packaging_id: l.packaging_id,
              name:         pkg?.name ?? "",
              volume_fl_oz: pkg?.volume_fl_oz,
              quantity:     parseInt(l.quantity) || 0,
            };
          }),
          total_kegs: kegLines.reduce((s, l) => s + (parseInt(l.quantity) || 0), 0),
        };
      } else if (showCanDetail) {
        transfer_type = "canning";
        const totalCans = (parseInt(cases) || 0) * cansPerCase + (parseInt(looseCans) || 0);
        canning_detail = {
          can_packaging_id:     canId,
          lid_packaging_id:     lidId || null,
          paktech_packaging_id: paktechId || null,
          tray_packaging_id:    trayId,
          label_packaging_id:   labelId || null,
          cans_per_case:        cansPerCase,
          cases:                parseInt(cases) || 0,
          loose_cans:           parseInt(looseCans) || 0,
          total_cans:           totalCans,
        };
      }

      const res = await fetch("/api/production/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id:      batch.id,
          from_tank_id:  fromTank.id,
          to_tank_id:    effectiveDestId,
          volume_bbl:    drawBbl,
          shrinkage_bbl: shrinkBbl,
          transfer_type,
          notes:         notes || null,
          kegging_detail,
          canning_detail,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      const responseData = await res.json();
      await onDone(responseData);
      onClose();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Transfer Batch" onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Batch summary */}
        <div className="flex gap-3 p-3 rounded bg-zinc-900/60 border border-zinc-800 text-sm">
          <div>
            <span className="text-zinc-500 text-xs">Batch</span>
            <p className="text-zinc-100 font-medium">{batch.beer_name}</p>
            <p className="text-zinc-500 font-mono text-xs">{batch.batch_number ?? "—"}</p>
          </div>
          <div className="mx-2 w-px bg-zinc-800" />
          <div>
            <span className="text-zinc-500 text-xs">From</span>
            <p className="text-zinc-100">{fromTank.name}</p>
            <p className="text-zinc-500 text-xs">{EQ[fromTank.type]?.label ?? fromTank.type}</p>
          </div>
          <div className="mx-2 w-px bg-zinc-800" />
          <div>
            <span className="text-zinc-500 text-xs">Batch Volume</span>
            <p className="text-zinc-100">{fmtBbl(batchVol)}</p>
          </div>
        </div>

        {/* Mode toggle — only shown for fermenters */}
        {canConvert && (
          <div className="flex gap-2">
            <button type="button" onClick={() => handleModeChange("transfer")}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${mode === "transfer" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              Transfer
            </button>
            <button type="button" onClick={() => handleModeChange("convert")}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${mode === "convert" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              Convert
            </button>
          </div>
        )}

        {/* Convert mode description */}
        {mode === "convert" && (
          <div className="px-3 py-2 rounded border border-amber-700/40 bg-amber-950/30 text-xs text-amber-300">
            Split a partial volume into a <span className="font-semibold">new batch</span> under a different recipe. The remaining volume stays in {fromTank.name} under the original batch.
          </div>
        )}

        {/* Allowed-destinations hint (transfer mode only) */}
        {mode === "transfer" && (
          <p className="text-xs text-zinc-500 bg-zinc-800/40 px-3 py-1.5 rounded border border-zinc-700">
            {fromTank.type === "brewhouse" && "Brewhouse → Fermenter only"}
            {fromTank.type === "fermenter" && "Fermenter → Brite, Kegging, or Canning"}
            {fromTank.type === "brite"     && "Brite → Fermenter, Kegging, or Canning"}
            {(fromTank.type === "kegging" || fromTank.type === "canning") && "Packaging → Cold Storage or Export Bay only"}
          </p>
        )}

        <Field label={mode === "convert" ? "Destination Fermenter" : "Destination"} required>
          {/* Planned booking pill (transfer mode only) */}
          {mode === "transfer" && plannedEntry && plannedEntry.equipment_id && (
            <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded bg-zinc-800/60 border border-zinc-700 text-xs text-zinc-400">
              <span>📋 Planned:</span>
              <span className="text-zinc-200 font-medium">{plannedEntry.equipment?.name ?? "Unknown"}</span>
              <span className="text-zinc-500">
                {format(parseISO(plannedEntry.planned_start), "MMM d")}–{format(parseISO(plannedEntry.planned_end), "MMM d")}
              </span>
            </div>
          )}
          <select className="inp" value={effectiveDestId} required onChange={(e) => setDestId(e.target.value)}>
            <option value="">— select —</option>
            {destTanks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({EQ[t.type]?.label ?? t.type})
                {t.capacity_bbl ? ` · ${t.capacity_bbl} BBL` : ""}
              </option>
            ))}
          </select>
          {destTanks.length === 0 && mode === "convert" && (
            <p className="text-xs text-zinc-500 mt-1">No free fermenters available.</p>
          )}
          {/* Deviation warning (transfer mode only) */}
          {mode === "transfer" && plannedEntry && plannedEntry.equipment_id && effectiveDestId && effectiveDestId !== plannedEntry.equipment_id && (
            <div className="mt-1.5 px-3 py-2 rounded border border-amber-700/60 bg-amber-950/40 text-xs text-amber-300">
              ⚠ <span className="font-semibold">Deviation from plan:</span> this batch was scheduled for{" "}
              <span className="text-amber-200 font-medium">{plannedEntry.equipment?.name ?? "another tank"}</span>.
              Proceeding will cancel that booking and may cause conflicts with downstream schedule entries that will need to be resolved.
            </div>
          )}
          {mode === "transfer" && destIsConstrained && destTank?.capacity_bbl && (
            <p className="text-xs text-zinc-500 mt-0.5">Capacity: {fmtBbl(destTank.capacity_bbl)} — transfer will be rejected if it exceeds this.</p>
          )}
        </Field>

        {/* ── Convert mode fields ── */}
        {mode === "convert" && (
          <>
            <Field label="New Recipe" required>
              <select className="inp" value={convertRecipeId} required onChange={(e) => {
                const r = recipes.find((r) => r.id === e.target.value);
                setConvertRecipeId(e.target.value);
                if (r && !convertBeerName) setConvertBeerName(r.beer_name);
              }}>
                <option value="">— select recipe —</option>
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.beer_name}{r.brewery ? ` · ${r.brewery}` : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="New Batch Name" required>
              <input className="inp" value={convertBeerName} required
                placeholder="e.g. Wheat Wit"
                onChange={(e) => setConvertBeerName(e.target.value)} />
            </Field>

            <Field label="Volume to Convert (BBL)" required>
              <div className="flex items-center gap-2">
                <input type="number" step="0.001" min="0.001" max={batchVol} className="inp w-40"
                  placeholder="0.000" required
                  value={convertBbl} onChange={(e) => setConvertBbl(e.target.value)} />
                <span className="text-zinc-500 text-sm">BBL</span>
              </div>
              {drawBbl > 0 && remaining <= 0 && (
                <p className="text-amber-400 text-xs mt-1">
                  Full conversion — the parent batch will be archived after this.
                </p>
              )}
            </Field>
          </>
        )}

        {/* ── Regular transfer: full / partial ── */}
        {mode === "transfer" && !isPackagingForm && (
          <Field label="Volume">
            <div className="flex gap-2 mb-2">
              <button type="button" onClick={() => setVolumeMode("full")}
                className={`px-3 py-1.5 text-sm rounded border transition-colors ${volumeMode === "full" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
                Full transfer
              </button>
              <button type="button" onClick={() => setVolumeMode("partial")}
                className={`px-3 py-1.5 text-sm rounded border transition-colors ${volumeMode === "partial" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
                Partial
              </button>
            </div>
            {volumeMode === "partial" && (
              <div className="flex items-center gap-2">
                <input type="number" step="0.001" min="0" max={batchVol} className="inp w-40" placeholder="0.000"
                  value={partialBbl} onChange={(e) => setPartialBbl(e.target.value)} />
                <span className="text-zinc-500 text-sm">BBL</span>
              </div>
            )}
          </Field>
        )}

        {/* ── Keg detail ── */}
        {showKegDetail && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-zinc-400">Kegs</label>
              <button type="button" onClick={() => setKegLines((l) => [...l, { packaging_id: "", quantity: "" }])}
                className="text-xs text-amber-500 hover:text-amber-400">+ Add keg type</button>
            </div>
            {kegs.length === 0 && (
              <p className="text-xs text-zinc-600">No kegs in Packaging. Add them in Inventory first.</p>
            )}
            <div className="space-y-2">
              {kegLines.map((line, i) => (
                <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: "1fr 64px auto" }}>
                  <select className="inp" value={line.packaging_id}
                    onChange={(e) => setKegLines((ls) => ls.map((l, idx) => idx === i ? { ...l, packaging_id: e.target.value } : l))}>
                    <option value="">— select keg —</option>
                    {kegs.map((k) => (
                      <option key={k.id} value={k.id}>
                        {pkgLabel(k)}{k.volume_fl_oz ? ` · ${k.volume_fl_oz} fl oz` : ""}
                        {k.is_default ? " ★" : ""}
                      </option>
                    ))}
                  </select>
                  <input type="number" min="0" className="inp" placeholder="qty"
                    value={line.quantity}
                    onChange={(e) => setKegLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity: e.target.value } : l))} />
                  {kegLines.length > 1
                    ? <button type="button" onClick={() => setKegLines((ls) => ls.filter((_, idx) => idx !== i))}
                        className="text-zinc-600 hover:text-red-400 text-lg leading-none">×</button>
                    : <span />}
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              Total kegs: {kegLines.reduce((s, l) => s + (parseInt(l.quantity) || 0), 0)} · Draw: {fmtBbl(drawBbl)}
            </p>
          </div>
        )}

        {/* ── Can detail ── */}
        {showCanDetail && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Can" required>
                <select className="inp" value={canId} required onChange={(e) => setCanId(e.target.value)}>
                  <option value="">— select —</option>
                  {cans.map((c) => <option key={c.id} value={c.id}>{pkgLabel(c)}{c.volume_fl_oz ? ` · ${c.volume_fl_oz} fl oz` : ""}{c.is_default ? " ★" : ""}</option>)}
                </select>
              </Field>
              <Field label="Lid" required>
                <select className="inp" value={lidId} required onChange={(e) => setLidId(e.target.value)}>
                  <option value="">— select —</option>
                  {lids.map((c) => <option key={c.id} value={c.id}>{pkgLabel(c)}{c.is_default ? " ★" : ""}</option>)}
                </select>
              </Field>
              <Field label="PakTech" required>
                <select className="inp" value={paktechId} required onChange={(e) => setPaktechId(e.target.value)}>
                  <option value="">— select —</option>
                  {paktechs.map((c) => <option key={c.id} value={c.id}>{pkgLabel(c)}{c.can_count ? ` · ${c.can_count}-pk` : ""}{c.is_default ? " ★" : ""}</option>)}
                </select>
              </Field>
              <Field label="Tray / Case Format" required>
                <select className="inp" value={trayId} required onChange={(e) => setTrayId(e.target.value)}>
                  <option value="">— select —</option>
                  {trays.map((c) => <option key={c.id} value={c.id}>{pkgLabel(c)}{c.can_count ? ` · ${c.can_count} cans/case` : ""}{c.is_default ? " ★" : ""}</option>)}
                </select>
              </Field>
              <Field label="Label" required>
                <select className="inp" value={labelId} required onChange={(e) => setLabelId(e.target.value)}>
                  <option value="">— select —</option>
                  {labels.map((c) => <option key={c.id} value={c.id}>{pkgLabel(c)}{c.is_default ? " ★" : ""}</option>)}
                </select>
              </Field>
            </div>
            {cansPerCase > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Cases (${cansPerCase} cans each)`}>
                  <input type="number" min="0" className="inp" placeholder="0" value={cases} onChange={(e) => setCases(e.target.value)} />
                </Field>
                <Field label="Loose cans">
                  <input type="number" min="0" className="inp" placeholder="0" value={looseCans} onChange={(e) => setLooseCans(e.target.value)} />
                </Field>
              </div>
            )}
            <p className="text-xs text-zinc-500">
              Total cans: {(parseInt(cases) || 0) * cansPerCase + (parseInt(looseCans) || 0)} · Draw: {fmtBbl(drawBbl)}
            </p>
          </div>
        )}

        {/* Shrinkage — not applicable for packaging out-transfers or conversions */}
        {mode === "transfer" && !isPackagingForm && (
          <Field label="Shrinkage (BBL)">
            <div className="flex items-center gap-2">
              <input type="number" step="0.001" min="0" className="inp w-40" placeholder="0.000"
                value={shrinkage} onChange={(e) => setShrinkage(e.target.value)} />
              <span className="text-zinc-500 text-sm">BBL lost</span>
            </div>
          </Field>
        )}

        {/* Volume summary */}
        <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 text-xs space-y-1">
          <div className="flex justify-between text-zinc-400">
            <span>Batch volume</span><span>{fmtBbl(batchVol)}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>{mode === "convert" ? "Converted volume" : "Transfer draw"}</span>
            <span>− {fmtBbl(drawBbl)}</span>
          </div>
          {mode === "transfer" && shrinkBbl > 0 && (
            <div className="flex justify-between text-zinc-400">
              <span>Shrinkage</span><span>− {fmtBbl(shrinkBbl)}</span>
            </div>
          )}
          <div className={`flex justify-between font-medium border-t border-zinc-800 pt-1 mt-1 ${remaining < 0 ? "text-red-400" : "text-zinc-100"}`}>
            <span>Remaining</span><span>{fmtBbl(remaining)}</span>
          </div>
        </div>
        {remaining < -0.001 && (
          <p className="text-xs text-red-400">Warning: volume exceeds batch volume.</p>
        )}
        {mode === "transfer" && destIsConstrained && destTank?.capacity_bbl && drawBbl > destTank.capacity_bbl && (
          <p className="text-xs text-red-400">
            Transfer ({fmtBbl(drawBbl)}) exceeds {destTank.name} capacity ({fmtBbl(destTank.capacity_bbl)}).
          </p>
        )}

        <Field label="Notes">
          <input className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <ModalActions submitting={submitting} onCancel={onClose}
          label={mode === "convert" ? "Convert Batch" : "Record Transfer"} />
      </form>
    </Modal>
  );
}
