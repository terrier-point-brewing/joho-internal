"use client";

import React, { useState } from "react";
import { Equipment, BrewBatch, PackagingItem, UNCONSTRAINED_EQUIPMENT_TYPES } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { EQ } from "../equipmentMeta";
import { fmtBbl } from "@/lib/utils/formatting";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

// Cold storage is only reachable from kegging or canning
const COLD_STORAGE_SOURCES = new Set(["kegging", "canning"]);

interface KegLine { packaging_id: string; quantity: string }

interface TransferModalProps {
  batch: BrewBatch;
  fromTank: Equipment;
  allTanks: Equipment[];
  packaging: PackagingItem[];
  onClose: () => void;
  onDone: () => Promise<void>;
}

export default function TransferModal({ batch, fromTank, allTanks, packaging, onClose, onDone }: TransferModalProps) {
  const destTanks = allTanks.filter((t) => {
    if (t.id === fromTank.id) return false;
    if (t.type === "backlog") return false;
    // Cold storage only reachable from kegging / canning
    if (t.type === "cold_storage" && !COLD_STORAGE_SOURCES.has(fromTank.type)) return false;
    return true;
  });

  const [destId, setDestId] = useState(destTanks[0]?.id ?? "");
  const [volumeMode, setVolumeMode] = useState<"full" | "partial">("full");
  const [partialBbl, setPartialBbl] = useState("");
  const [shrinkage, setShrinkage] = useState("0");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Kegging state
  const [kegLines, setKegLines] = useState<KegLine[]>([{ packaging_id: "", quantity: "" }]);

  // Canning state
  const [canId, setCanId] = useState("");
  const [lidId, setLidId] = useState("");
  const [paktechId, setPaktechId] = useState("");
  const [trayId, setTrayId] = useState("");
  const [cases, setCases] = useState("");
  const [looseCans, setLooseCans] = useState("0");

  const destTank  = allTanks.find((t) => t.id === destId);
  const isKegging = destTank?.type === "kegging";
  const isCanning = destTank?.type === "canning";
  const isSpecial = isKegging || isCanning;

  const kegs     = packaging.filter((p) => p.type === "keg");
  const cans     = packaging.filter((p) => p.type === "can");
  const lids     = packaging.filter((p) => p.type === "lid");
  const paktechs = packaging.filter((p) => p.type === "paktech");
  const trays    = packaging.filter((p) => p.type === "tray");

  const selectedTray = packaging.find((p) => p.id === trayId);
  const cansPerCase  = selectedTray?.can_count ?? 0;
  const selectedCan  = packaging.find((p) => p.id === canId);

  const batchVol  = Number(batch.volume_bbl);
  const shrinkBbl = parseFloat(shrinkage) || 0;

  let drawBbl = 0;
  if (isKegging) {
    drawBbl = kegLines.reduce((sum, l) => {
      const pkg = packaging.find((p) => p.id === l.packaging_id);
      const qty = parseInt(l.quantity) || 0;
      if (!pkg?.volume_fl_oz) return sum;
      return sum + (qty * pkg.volume_fl_oz) / BBL_TO_FL_OZ;
    }, 0);
  } else if (isCanning) {
    const totalCans = (parseInt(cases) || 0) * cansPerCase + (parseInt(looseCans) || 0);
    const canVol    = selectedCan?.volume_fl_oz ?? 0;
    drawBbl = (totalCans * canVol) / BBL_TO_FL_OZ;
  } else if (volumeMode === "full") {
    // Full transfer: draw is whatever is left after shrinkage
    drawBbl = Math.max(0, batchVol - shrinkBbl);
  } else {
    drawBbl = parseFloat(partialBbl) || 0;
  }

  const totalDraw = drawBbl + shrinkBbl;
  const remaining = batchVol - totalDraw;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!destId) return;
    setSubmitting(true);
    try {
      let kegging_detail = null;
      let canning_detail = null;
      let transfer_type: "transfer" | "kegging" | "canning" = "transfer";

      if (isKegging) {
        transfer_type = "kegging";
        kegging_detail = {
          kegs: kegLines.map((l) => {
            const pkg = packaging.find((p) => p.id === l.packaging_id);
            return { packaging_id: l.packaging_id, name: pkg?.name ?? "", volume_fl_oz: pkg?.volume_fl_oz, quantity: parseInt(l.quantity) || 0 };
          }),
          total_kegs: kegLines.reduce((s, l) => s + (parseInt(l.quantity) || 0), 0),
        };
      } else if (isCanning) {
        transfer_type = "canning";
        const totalCans = (parseInt(cases) || 0) * cansPerCase + (parseInt(looseCans) || 0);
        canning_detail = {
          can_packaging_id:     canId,
          lid_packaging_id:     lidId || null,
          paktech_packaging_id: paktechId || null,
          tray_packaging_id:    trayId,
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
          to_tank_id:    destId,
          volume_bbl:    drawBbl,
          shrinkage_bbl: shrinkBbl,
          transfer_type,
          notes:         notes || null,
          kegging_detail,
          canning_detail,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await onDone();
      onClose();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  const destHasCapacity = destTank ? !UNCONSTRAINED_EQUIPMENT_TYPES.includes(destTank.type) : true;

  return (
    <Modal title="Transfer Batch" onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
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
          </div>
          <div className="mx-2 w-px bg-zinc-800" />
          <div>
            <span className="text-zinc-500 text-xs">Batch Volume</span>
            <p className="text-zinc-100">{fmtBbl(batchVol)}</p>
          </div>
        </div>

        <Field label="Destination" required>
          <select className="inp" value={destId} required onChange={(e) => setDestId(e.target.value)}>
            <option value="">— select —</option>
            {destTanks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({EQ[t.type]?.label ?? t.type})
                {t.capacity_bbl ? ` · ${t.capacity_bbl} BBL` : ""}
              </option>
            ))}
          </select>
          {!destHasCapacity && destTank && (
            <p className="text-xs text-zinc-500 mt-0.5">{EQ[destTank.type]?.label} has no capacity limit.</p>
          )}
        </Field>

        {/* Regular transfer: full / partial */}
        {!isSpecial && (
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

        {/* Kegging */}
        {isKegging && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-zinc-400">Kegs to fill</label>
              <button type="button" onClick={() => setKegLines((l) => [...l, { packaging_id: "", quantity: "" }])}
                className="text-xs text-amber-500 hover:text-amber-400">+ Add keg type</button>
            </div>
            {kegs.length === 0 && (
              <p className="text-xs text-zinc-600">No kegs in Packaging. Add them in the Packaging tab first.</p>
            )}
            <div className="space-y-2">
              {kegLines.map((line, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <select className="inp flex-1" value={line.packaging_id}
                    onChange={(e) => setKegLines((ls) => ls.map((l, idx) => idx === i ? { ...l, packaging_id: e.target.value } : l))}>
                    <option value="">— select keg —</option>
                    {kegs.map((k) => (
                      <option key={k.id} value={k.id}>{k.name} ({k.volume_fl_oz} fl oz)</option>
                    ))}
                  </select>
                  <input type="number" min="0" className="inp w-24" placeholder="qty"
                    value={line.quantity}
                    onChange={(e) => setKegLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity: e.target.value } : l))} />
                  {kegLines.length > 1 && (
                    <button type="button" onClick={() => setKegLines((ls) => ls.filter((_, idx) => idx !== i))}
                      className="text-zinc-600 hover:text-red-400 text-lg leading-none">×</button>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-500 mt-2">Draw: {fmtBbl(drawBbl)}</p>
          </div>
        )}

        {/* Canning */}
        {isCanning && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Can" required>
                <select className="inp" value={canId} required onChange={(e) => setCanId(e.target.value)}>
                  <option value="">— select —</option>
                  {cans.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.volume_fl_oz} fl oz)</option>)}
                </select>
              </Field>
              <Field label="Lid">
                <select className="inp" value={lidId} onChange={(e) => setLidId(e.target.value)}>
                  <option value="">— none —</option>
                  {lids.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="PakTech">
                <select className="inp" value={paktechId} onChange={(e) => setPaktechId(e.target.value)}>
                  <option value="">— none —</option>
                  {paktechs.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.can_count}-pk)</option>)}
                </select>
              </Field>
              <Field label="Tray / Case Format" required>
                <select className="inp" value={trayId} required onChange={(e) => setTrayId(e.target.value)}>
                  <option value="">— select —</option>
                  {trays.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.can_count} cans/case)</option>)}
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

        <Field label="Shrinkage (BBL)">
          <div className="flex items-center gap-2">
            <input type="number" step="0.001" min="0" className="inp w-40" placeholder="0.000"
              value={shrinkage} onChange={(e) => setShrinkage(e.target.value)} />
            <span className="text-zinc-500 text-sm">BBL lost</span>
          </div>
          {!isSpecial && volumeMode === "full" && shrinkBbl > 0 && (
            <p className="text-xs text-zinc-500 mt-0.5">Shrinkage deducted from full transfer draw automatically.</p>
          )}
        </Field>

        {/* Volume summary */}
        <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 text-xs space-y-1">
          <div className="flex justify-between text-zinc-400">
            <span>Batch volume</span><span>{fmtBbl(batchVol)}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>Transfer draw</span><span>− {fmtBbl(drawBbl)}</span>
          </div>
          {shrinkBbl > 0 && (
            <div className="flex justify-between text-zinc-400">
              <span>Shrinkage</span><span>− {fmtBbl(shrinkBbl)}</span>
            </div>
          )}
          <div className={`flex justify-between font-medium border-t border-zinc-800 pt-1 mt-1 ${remaining < 0 ? "text-red-400" : "text-zinc-100"}`}>
            <span>Remaining</span><span>{fmtBbl(remaining)}</span>
          </div>
        </div>
        {remaining < -0.001 && (
          <p className="text-xs text-red-400">Warning: transfer exceeds batch volume.</p>
        )}

        <Field label="Notes">
          <input className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <ModalActions submitting={submitting} onCancel={onClose} label="Record Transfer" />
      </form>
    </Modal>
  );
}
