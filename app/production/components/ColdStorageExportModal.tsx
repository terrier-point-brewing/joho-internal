"use client";

import React, { useMemo, useState } from "react";
import { BatchTransfer, Equipment } from "../types";
import { Modal, Field } from "./shared";
import { useContractPartnersQuery } from "../hooks/queries";

export type ExportChannel = "taproom" | "distribution" | "contract_brewing";

const CHANNEL_OPTIONS: { key: ExportChannel; label: string }[] = [
  { key: "taproom",           label: "Taproom" },
  { key: "distribution",      label: "Distribution" },
  { key: "contract_brewing",  label: "Contract Brewing" },
];

interface ColdInventoryLine {
  /** product_label e.g. "1/6 BBL" for kegs, "can" for cans */
  productLabel: string;
  productType: "keg" | "can";
  beerName: string;
  available: number;
}

interface Props {
  coldStorageTank: Equipment;
  /** All transfers (used to compute cold storage inventory and prior exports) */
  transfers: BatchTransfer[];
  /** batch lookup for beer names */
  batchById: Record<string, { id: string; beer_name: string; planned_brew_date: string }>;
  onClose: () => void;
  onDone: () => Promise<void>;
}

export default function ColdStorageExportModal({ coldStorageTank, transfers, batchById, onClose, onDone }: Props) {
  const { data: partners = [] } = useContractPartnersQuery();

  // ── Compute available inventory ─────────────────────────────────────────────
  const inventory = useMemo(() => {
    // Inbound: kegging/canning transfers to this cold storage tank, oldest first
    const inbound = transfers
      .filter((t) => t.to_tank_id === coldStorageTank.id && (t.transfer_type === "kegging" || t.transfer_type === "canning"))
      .sort((a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime());

    // Map: "batchTransferId|productLabel" → { qty: totalIn, exported: 0 }
    type Entry = {
      batchTransferId: string;
      batchId: string;
      productLabel: string;
      productType: "keg" | "can";
      totalQty: number;
      exportedQty: number;
      beerName: string;
    };
    const entries: Entry[] = [];

    for (const tr of inbound) {
      const beerName = batchById[tr.batch_id]?.beer_name ?? "Unknown";
      if (tr.transfer_type === "kegging" && tr.kegging_detail?.kegs) {
        for (const keg of tr.kegging_detail.kegs as { name: string; quantity: number }[]) {
          if (keg.quantity > 0) {
            entries.push({
              batchTransferId: tr.id,
              batchId: tr.batch_id,
              productLabel: keg.name,
              productType: "keg",
              totalQty: keg.quantity,
              exportedQty: 0,
              beerName,
            });
          }
        }
      } else if (tr.transfer_type === "canning" && tr.canning_detail?.total_cans != null) {
        entries.push({
          batchTransferId: tr.id,
          batchId: tr.batch_id,
          productLabel: "can",
          productType: "can",
          totalQty: tr.canning_detail.total_cans as number,
          exportedQty: 0,
          beerName,
        });
      }
    }

    // Subtract prior exports (transfer_type = "export" from this tank)
    const priorExports = transfers.filter(
      (t) => t.from_tank_id === coldStorageTank.id && t.transfer_type === "export"
    );
    for (const ex of priorExports) {
      const detail = ex.export_detail as {
        items?: { source_transfer_id: string; product_label: string; quantity: number }[];
      } | null;
      if (!detail?.items) continue;
      for (const ei of detail.items) {
        const entry = entries.find(
          (e) => e.batchTransferId === ei.source_transfer_id && e.productLabel === ei.product_label
        );
        if (entry) entry.exportedQty += ei.quantity;
      }
    }

    // Aggregate available by (beerName, productLabel, productType) for display
    const agg = new Map<string, ColdInventoryLine>();
    for (const e of entries) {
      const avail = e.totalQty - e.exportedQty;
      const key = `${e.beerName}|${e.productType}|${e.productLabel}`;
      const existing = agg.get(key);
      if (existing) {
        existing.available += avail;
      } else {
        agg.set(key, { productLabel: e.productLabel, productType: e.productType, beerName: e.beerName, available: avail });
      }
    }
    return [...agg.values()];
  }, [coldStorageTank.id, transfers, batchById]);

  // ── Form state ──────────────────────────────────────────────────────────────
  const [channel, setChannel] = useState<ExportChannel>("taproom");
  const [partnerId, setPartnerId] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [notes, setNotes] = useState("");
  // quantities keyed by `beerName|productType|productLabel`
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setQty(line: ColdInventoryLine, val: string) {
    const key = `${line.beerName}|${line.productType}|${line.productLabel}`;
    setQuantities((q) => ({ ...q, [key]: val }));
  }
  function getQty(line: ColdInventoryLine) {
    const key = `${line.beerName}|${line.productType}|${line.productLabel}`;
    return quantities[key] ?? "";
  }

  const selectedItems = inventory.filter((l) => {
    const v = parseFloat(getQty(l));
    return v > 0;
  });

  const hasSelections = selectedItems.length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasSelections) return;
    setSubmitting(true);
    setError(null);

    // Validation
    for (const line of selectedItems) {
      const qty = parseFloat(getQty(line));
      if (qty > line.available) {
        setError(`Requested ${qty} × ${line.productLabel} ${line.beerName} but only ${line.available} available`);
        setSubmitting(false);
        return;
      }
    }

    const partner = partners.find((p) => p.id === partnerId);

    try {
      const res = await fetch("/api/production/cold-storage-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cold_storage_tank_id: coldStorageTank.id,
          items: selectedItems.map((l) => ({
            product_label: l.productLabel,
            product_type: l.productType,
            quantity: parseFloat(getQty(l)),
          })),
          channel,
          partner_id: channel === "contract_brewing" ? (partnerId || null) : null,
          partner_name: channel === "contract_brewing" ? (partner?.company_name ?? null) : null,
          recipient_name: recipientName || null,
          notes: notes || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? "Export failed");
      }
      await onDone();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Group inventory lines by beer name for display
  const grouped = useMemo(() => {
    const map = new Map<string, ColdInventoryLine[]>();
    for (const line of inventory) {
      if (!map.has(line.beerName)) map.set(line.beerName, []);
      map.get(line.beerName)!.push(line);
    }
    return [...map.entries()];
  }, [inventory]);

  return (
    <Modal title={`Export from ${coldStorageTank.name}`} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-5">

        {/* Inventory selection */}
        <div>
          <p className="text-xs font-medium text-zinc-400 mb-2">Select items to export</p>
          {grouped.length === 0 ? (
            <p className="text-sm text-zinc-600">No inventory in cold storage.</p>
          ) : (
            <div className="space-y-4">
              {grouped.map(([beerName, lines]) => (
                <div key={beerName}>
                  <p className="text-xs text-zinc-500 font-medium mb-1.5">{beerName}</p>
                  <div className="space-y-1.5 pl-2">
                    {lines.map((line) => {
                      const qty = getQty(line);
                      const parsed = parseFloat(qty) || 0;
                      const over = parsed > line.available;
                      const depleted = line.available === 0;
                      return (
                        <div key={`${line.productType}|${line.productLabel}`} className={`flex items-center gap-3 ${depleted ? "opacity-40" : ""}`}>
                          <div className="flex-1 text-sm text-zinc-300">
                            {line.productLabel}
                            <span className="ml-2 text-xs text-zinc-600">
                              {line.productType === "keg" ? "keg" : "cans"} · {line.available} available
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              min="0"
                              max={line.available}
                              step="1"
                              disabled={depleted}
                              className={`w-20 px-2 py-1 text-sm text-right rounded border bg-zinc-900 text-zinc-100 focus:outline-none focus:border-amber-600 disabled:cursor-not-allowed ${over ? "border-red-600" : "border-zinc-700"}`}
                              placeholder="0"
                              value={qty}
                              onChange={(e) => setQty(line, e.target.value)}
                            />
                            <span className="text-xs text-zinc-600">/ {line.available}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 pt-4 space-y-4">
          {/* Channel */}
          <Field label="Channel" required>
            <div className="flex gap-2">
              {CHANNEL_OPTIONS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setChannel(key)}
                  className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                    channel === key
                      ? "border-amber-600 bg-amber-900/30 text-amber-300"
                      : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>

          {/* Contract Brewing partner */}
          {channel === "contract_brewing" && (
            <Field label="Contract Brewing Partner" required>
              <select
                className="inp"
                value={partnerId}
                required={channel === "contract_brewing"}
                onChange={(e) => setPartnerId(e.target.value)}
              >
                <option value="">— select partner —</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>{p.company_name}</option>
                ))}
              </select>
            </Field>
          )}

          {/* Recipient name (optional for taproom, optional for distribution) */}
          {channel !== "contract_brewing" && (
            <Field label={channel === "taproom" ? "Location (optional)" : "Recipient / Location (optional)"}>
              <input
                className="inp"
                placeholder={channel === "taproom" ? "e.g. Main taproom" : "e.g. Distributor name"}
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
              />
            </Field>
          )}

          <Field label="Notes (optional)">
            <input className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {hasSelections && (
          <div className="text-xs text-zinc-500 bg-zinc-800/40 px-3 py-2 rounded border border-zinc-700">
            Exporting:{" "}
            {selectedItems.map((l, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <span className="text-zinc-300">{parseFloat(getQty(l))} × {l.productLabel} {l.beerName}</span>
              </span>
            ))}
            {" → "}
            <span className="text-amber-300">{CHANNEL_OPTIONS.find((c) => c.key === channel)?.label}</span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost text-sm" disabled={submitting}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!hasSelections || submitting}
            className="btn-amber disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Exporting…" : "Export"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
