"use client";

import { useMemo, useState } from "react";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import { useColdStorageQuery, usePackagingVariationsQuery, type ColdStorageLot } from "../hooks/queries";
import { previewTransform } from "@/lib/production/coldStorageTransform";

// Record a cold-storage transform: crack stock already in the cold room into a
// different packaging variation of the SAME batch. The motivating case is a 1/2
// keg broken down into sixtels, which loses volume — you rarely get the full
// three a half-keg's 1984 fl oz would allow.
//
// The operator enters the count they ACTUALLY filled. The modal never rounds it
// up to make the volume tie; the difference is shrinkage and gets recorded.
//
// The DB is the enforcer (cold_storage_transforms_never_creates_volume). The
// preview here just means an impossible count is visible before they commit.

/** Lots must share a container class to be a plausible transform — you don't
 *  crack a keg into cans. Kegs and cans each stay within their own world. */
function sameContainerClass(a: string | null, b: string | null): boolean {
  return (a ?? "") === (b ?? "");
}

export default function ColdStorageTransformModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  // isPending, not isLoading — see ColdStorageAdjustmentsTab for why. Here it
  // only decides a placeholder, but "Select a lot…" over an empty list reads as
  // "there is no stock" when the load simply hasn't landed.
  const { data: lots = [], isPending: lotsLoading } = useColdStorageQuery();
  const { data: variations = [] } = usePackagingVariationsQuery();

  const [lotId, setLotId] = useState("");
  const [toVariationId, setToVariationId] = useState("");
  const [fromUnits, setFromUnits] = useState("1");
  const [toUnits, setToUnits] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only lots holding at least one whole unit can be cracked — a 0.4 keg isn't
  // a keg you can break down.
  const eligibleLots = useMemo(
    () => lots.filter((l) => l.quantity_on_hand >= 1).sort((a, b) => (a.beer_name ?? "").localeCompare(b.beer_name ?? "")),
    [lots],
  );

  const lot: ColdStorageLot | undefined = eligibleLots.find((l) => l.id === lotId);
  const variationById = useMemo(() => new Map(variations.map((v) => [v.id, v])), [variations]);
  const sourceVariation = lot ? variationById.get(lot.variation_id) : undefined;

  // Candidate targets: same container class, not the source itself, and active.
  const targets = useMemo(() => {
    if (!lot) return [];
    return variations
      .filter(
        (v) =>
          v.is_active &&
          v.id !== lot.variation_id &&
          sameContainerClass(v.container?.type ?? null, lot.container_type),
      )
      .sort((a, b) => Number(b.total_volume_fl_oz) - Number(a.total_volume_fl_oz));
  }, [variations, lot]);

  const target = targets.find((v) => v.id === toVariationId);

  const fromUnitsNum = Number(fromUnits);
  const toUnitsNum = Number(toUnits);
  const countsEntered =
    Number.isFinite(fromUnitsNum) && fromUnitsNum > 0 && Number.isFinite(toUnitsNum) && toUnitsNum > 0;

  const preview =
    sourceVariation && target && countsEntered
      ? previewTransform({
          fromUnits: fromUnitsNum,
          fromVolumeFlOz: Number(sourceVariation.total_volume_fl_oz),
          toUnits: toUnitsNum,
          toVolumeFlOz: Number(target.total_volume_fl_oz),
        })
      : null;

  const overdrawn = !!lot && Number.isFinite(fromUnitsNum) && fromUnitsNum > lot.quantity_on_hand;
  const blocked = !lot || !target || !countsEntered || overdrawn || !!preview?.createsVolume;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/production/cold-storage/transform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lot_id: lotId,
          to_variation_id: toVariationId,
          from_units: fromUnitsNum,
          to_units: toUnitsNum,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not record that transform.");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record that transform.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Transform Cold Storage Stock" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted">
          Repackage stock already in the cold room — a half keg into sixtels, say. The beer stays in
          cold storage and stays on the same batch. Enter the number of units you actually filled;
          any volume lost along the way is recorded as shrinkage.
        </p>

        <Field label="Source lot" required>
          <select
            className="inp w-full"
            value={lotId}
            onChange={(e) => {
              setLotId(e.target.value);
              setToVariationId("");
              setToUnits("");
            }}
          >
            <option value="">{lotsLoading ? "Loading…" : "Select a lot…"}</option>
            {eligibleLots.map((l) => (
              <option key={l.id} value={l.id}>
                {l.beer_name ?? "Unknown"} · {l.batch_number ?? "—"} · {l.variation_name ?? "—"} ({l.quantity_on_hand} on hand)
              </option>
            ))}
          </select>
        </Field>

        <Field label="Break down into" required hint={lot ? undefined : "pick a source lot first"}>
          <select
            className="inp w-full"
            value={toVariationId}
            onChange={(e) => setToVariationId(e.target.value)}
            disabled={!lot}
          >
            <option value="">{lot ? "Select packaging…" : "—"}</option>
            {targets.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Units cracked" required>
            <input
              type="number"
              min="1"
              step="1"
              className="inp w-full"
              value={fromUnits}
              onChange={(e) => setFromUnits(e.target.value)}
            />
          </Field>
          <Field
            label="Units filled"
            required
            hint={preview && preview.maxToUnits > 0 ? `max ${preview.maxToUnits}` : undefined}
          >
            <input
              type="number"
              min="1"
              step="1"
              className="inp w-full"
              value={toUnits}
              onChange={(e) => setToUnits(e.target.value)}
              disabled={!target}
            />
          </Field>
        </div>

        {overdrawn && lot && (
          <Banner tone="danger">
            That lot only holds {lot.quantity_on_hand}. You can&apos;t crack more than is there.
          </Banner>
        )}

        {preview?.createsVolume && (
          <Banner tone="danger">
            {toUnitsNum} × {target?.name} holds more beer than {fromUnitsNum} × {sourceVariation?.name} did.
            A transform can lose volume, never create it — the most that fits is {preview.maxToUnits}.
          </Banner>
        )}

        {preview && !preview.createsVolume && (
          <div className="rounded-lg bg-surface border border-line p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted">Volume in</span>
              <span className="text-strong tabular-nums">{preview.sourceVolumeFlOz.toLocaleString()} fl oz</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Volume out</span>
              <span className="text-strong tabular-nums">{preview.producedVolumeFlOz.toLocaleString()} fl oz</span>
            </div>
            <div className="flex justify-between text-sm font-semibold border-t border-line-strong pt-2 mt-1">
              <span className="text-body">Shrinkage</span>
              <span className="text-accent tabular-nums">
                {preview.shrinkageBbl.toFixed(3)} bbl ({(preview.shrinkageRatio * 100).toFixed(1)}%)
              </span>
            </div>
          </div>
        )}

        <Field label="Note" hint="what happened — e.g. foam loss on the second fill">
          <input
            type="text"
            className="inp w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional"
          />
        </Field>

        {error && <Banner tone="danger">{error}</Banner>}

        <ModalActions submitting={submitting} onCancel={onClose} label="Record Transform" disabled={blocked} />
      </form>
    </Modal>
  );
}
