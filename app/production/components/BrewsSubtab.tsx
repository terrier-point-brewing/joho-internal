"use client";

import React, { useState, useCallback } from "react";
import { BatchTransfer, Equipment, BrewBatch, BrewInventoryAdjustment, BrewAdjustmentType } from "../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "./shared";

const fmtDate = fmtDateLong;

const BREW_ADJ_TYPES: { value: BrewAdjustmentType; label: string; hint: string }[] = [
  { value: "sold",            label: "Sold",            hint: "Units sold to customer" },
  { value: "distributed",    label: "Distributed",     hint: "Moved to distribution" },
  { value: "waste",          label: "Waste / Loss",    hint: "Damaged or written off" },
  { value: "inventory_count",label: "Inventory Count", hint: "Set actual unit count" },
];

interface BrewLot extends BatchTransfer {
  initialQty: number;
  unit: "keg" | "can";
}

function getInitialQty(t: BatchTransfer): { qty: number; unit: "keg" | "can" } {
  if (t.transfer_type === "kegging") {
    const d = t.kegging_detail as { total_kegs?: number } | null;
    return { qty: d?.total_kegs ?? 0, unit: "keg" };
  }
  const d = t.canning_detail as { total_cans?: number } | null;
  return { qty: d?.total_cans ?? 0, unit: "can" };
}

function AdjustModal({
  lot,
  currentQty,
  onClose,
  onDone,
}: {
  lot: BrewLot;
  currentQty: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [adjType, setAdjType] = useState<BrewAdjustmentType>("sold");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        batch_transfer_id: lot.id,
        type: adjType,
        note: note || null,
        initial_qty: lot.initialQty,
      };
      if (adjType === "inventory_count") {
        body.new_total = parseFloat(qty);
      } else {
        body.quantity = parseFloat(qty);
      }
      const res = await fetch("/api/production/brew-adjustments", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onDone();
      onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Adjust Inventory — ${lot.unit === "keg" ? "Kegs" : "Cans"}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="p-3 bg-zinc-800/50 rounded text-sm grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-zinc-500 mb-0.5">Current stock</p>
            <p className="text-zinc-100 font-medium">{currentQty} {lot.unit}{currentQty !== 1 ? "s" : ""}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-0.5">Initial qty</p>
            <p className="text-zinc-100 font-medium">{lot.initialQty} {lot.unit}{lot.initialQty !== 1 ? "s" : ""}</p>
          </div>
        </div>

        <Field label="Adjustment Type" required>
          <div className="grid grid-cols-2 gap-2">
            {BREW_ADJ_TYPES.map((t) => (
              <button key={t.value} type="button" onClick={() => setAdjType(t.value)}
                className={`px-3 py-2 rounded border text-sm text-left transition-colors ${adjType === t.value ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"}`}>
                <div className="font-medium">{t.label}</div>
                <div className="text-xs opacity-70 mt-0.5">{t.hint}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label={adjType === "inventory_count" ? "New Total" : "Quantity"} required>
          <input type="number" step="1" min="0" className="inp" required
            placeholder={adjType === "inventory_count" ? "Enter new total" : "Enter quantity"}
            value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>

        <Field label="Note">
          <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <ModalActions submitting={submitting} onCancel={onClose} label="Record Adjustment" />
      </form>
    </Modal>
  );
}

function BrewLotRow({
  lot,
  batch,
  tank,
  i,
}: {
  lot: BrewLot;
  batch: BrewBatch | undefined;
  tank: Equipment | undefined;
  i: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [adjLog, setAdjLog] = useState<BrewInventoryAdjustment[]>([]);
  const [adjLoaded, setAdjLoaded] = useState(false);
  const [showAdjModal, setShowAdjModal] = useState(false);

  const loadAdj = useCallback(async () => {
    const r = await fetch(`/api/production/brew-adjustments?batch_transfer_id=${lot.id}`);
    if (r.ok) { setAdjLog(await r.json()); setAdjLoaded(true); }
  }, [lot.id]);

  async function toggle() {
    if (!adjLoaded) await loadAdj();
    setExpanded((v) => !v);
  }

  const currentQty = lot.initialQty + adjLog.reduce((s, a) => s + Number(a.quantity), 0);

  return (
    <React.Fragment>
      <tr className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""} ${expanded ? "border-b-0" : ""}`}>
        <td className="px-3 py-2.5">
          <button onClick={toggle} className="text-zinc-600 hover:text-zinc-400 transition-colors text-xs">
            {expanded ? "▼" : "▶"}
          </button>
        </td>
        <td className="px-4 py-2.5 text-zinc-400 text-xs whitespace-nowrap">{fmtDate(lot.transferred_at)}</td>
        <td className="px-4 py-2.5 font-mono text-xs text-zinc-500">{batch?.batch_number ?? "—"}</td>
        <td className="px-4 py-2.5 text-zinc-100 font-medium">{batch?.beer_name ?? "—"}</td>
        <td className="px-4 py-2.5 text-zinc-400">{tank?.name ?? "—"}</td>
        <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">{lot.initialQty}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">
          <span className={currentQty <= 0 ? "text-zinc-600" : currentQty < lot.initialQty * 0.25 ? "text-amber-400" : "text-green-400"}>
            {adjLoaded ? currentQty : lot.initialQty}
          </span>
        </td>
        <td className="px-4 py-2.5 text-zinc-400 text-right tabular-nums">{Number(lot.volume_bbl).toFixed(2)}</td>
        <td className="px-4 py-2.5 text-zinc-500 text-xs max-w-[120px] truncate">{lot.notes ?? "—"}</td>
        <td className="px-4 py-2.5">
          <button onClick={() => { if (!adjLoaded) loadAdj(); setShowAdjModal(true); }}
            className="text-xs text-amber-500 hover:text-amber-400 transition-colors font-medium">Adjust</button>
        </td>
      </tr>

      {expanded && (
        <tr className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
          <td colSpan={10} className="px-6 pb-4 pt-1">
            {adjLog.length === 0 ? (
              <p className="text-xs text-zinc-600">No adjustments recorded yet.</p>
            ) : (
              <div className="overflow-x-auto rounded border border-zinc-800/60">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900/40 text-left">
                      {["Date", "Type", "Change", "Note"].map((h) => (
                        <th key={h} className={`px-3 py-2 font-medium text-zinc-500 ${h === "Change" ? "text-right" : ""}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...adjLog].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()).map((a, j) => (
                      <tr key={a.id} className={`border-b border-zinc-800/40 ${j % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                        <td className="px-3 py-2 text-zinc-500 whitespace-nowrap">
                          {new Date(a.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </td>
                        <td className="px-3 py-2 text-zinc-400 capitalize">
                          {BREW_ADJ_TYPES.find((t) => t.value === a.type)?.label ?? a.type}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums font-mono ${a.quantity >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {a.quantity >= 0 ? "+" : ""}{Number(a.quantity)}
                        </td>
                        <td className="px-3 py-2 text-zinc-500 max-w-[160px] truncate">{a.note ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}

      {showAdjModal && (
        <AdjustModal
          lot={lot}
          currentQty={currentQty}
          onClose={() => setShowAdjModal(false)}
          onDone={() => { loadAdj(); }}
        />
      )}
    </React.Fragment>
  );
}

export default function BrewsSubtab({
  transfers,
  tanks,
  batches,
}: {
  transfers: BatchTransfer[];
  tanks: Equipment[];
  batches: BrewBatch[];
}) {
  const coldStorageTankIds = new Set(tanks.filter((t) => t.type === "cold_storage").map((t) => t.id));
  const brewTransfers = transfers.filter(
    (t) => t.to_tank_id && coldStorageTankIds.has(t.to_tank_id) && (t.transfer_type === "kegging" || t.transfer_type === "canning")
  );

  const batchById = Object.fromEntries(batches.map((b) => [b.id, b]));
  const tankById  = Object.fromEntries(tanks.map((t) => [t.id, t]));

  const kegs: BrewLot[] = brewTransfers.filter((t) => t.transfer_type === "kegging").map((t) => {
    const { qty } = getInitialQty(t);
    return { ...t, initialQty: qty, unit: "keg" as const };
  });
  const cans: BrewLot[] = brewTransfers.filter((t) => t.transfer_type === "canning").map((t) => {
    const { qty } = getInitialQty(t);
    return { ...t, initialQty: qty, unit: "can" as const };
  });

  if (brewTransfers.length === 0) {
    return (
      <div>
          <p className="text-zinc-600 text-sm">No kegged or canned batches in cold storage yet.</p>
      </div>
    );
  }

  const COLS = ["", "Date", "Batch #", "Beer", "Storage", "Initial Qty", "Current Qty", "Volume (BBL)", "Notes", ""];

  return (
    <div className="space-y-8">
      {[
        { label: "Kegs", lots: kegs },
        { label: "Cans", lots: cans },
      ].map(({ label, lots }) => {
        if (lots.length === 0) return null;
        return (
          <div key={label}>
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">{label} ({lots.length})</p>
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                    {COLS.map((h, idx) => (
                      <th key={idx} className={`px-${idx === 0 ? "3" : "4"} py-2.5 text-xs font-medium text-zinc-500 ${["Initial Qty", "Current Qty", "Volume (BBL)"].includes(h) ? "text-right" : ""}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lots.map((lot, i) => (
                    <BrewLotRow
                      key={lot.id}
                      lot={lot}
                      batch={batchById[lot.batch_id]}
                      tank={lot.to_tank_id ? tankById[lot.to_tank_id] : undefined}
                      i={i}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
