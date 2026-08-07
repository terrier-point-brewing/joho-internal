"use client";

import { useMemo, useState } from "react";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import { useColdStorageQuery, usePackagingVariationsQuery, type ColdStorageLot } from "../hooks/queries";
import { previewTransform } from "@/lib/production/coldStorageTransform";

// Record a cold-storage transform: reshape stock already in the cold room into a
// different packaging variation of the SAME batch. It runs both ways —
//
//   break down   1 x 1/2 Keg  ->  3 x 1/6 Keg
//   build up     3 x 1/6 Keg  ->  1 x 1/2 Keg
//
// — and the form is the same either way, so nothing here says "parent" or
// "crack". A build-up is how an operator gets stock into the shape a phantom
// export reconcile demands, which only accepts the exact keg size that was
// booked.
//
// Either direction loses volume: you leave beer in the lines breaking a half keg
// down, and you leave beer in the lines combining sixtels back up. The operator
// enters the count they ACTUALLY filled. The modal never rounds it to make the
// volumes tie; the difference is shrinkage and gets recorded.
//
// The DB is the enforcer (cold_storage_transforms_never_creates_volume). The
// preview here just means an impossible count is visible before they commit —
// and, because stored volumes are whole fl oz while a 1/6 bbl is really 661.33,
// that a one-ounce rounding gap is NOT mistaken for one.

/** Lots must share a container class to be a plausible transform — kegs and cans
 *  each stay within their own world, in either direction. */
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

  // Only lots holding at least one whole unit can be transformed — a 0.4 keg
  // isn't a keg you can reshape into anything.
  const eligibleLots = useMemo(
    () => lots.filter((l) => l.quantity_on_hand >= 1).sort((a, b) => (a.beer_name ?? "").localeCompare(b.beer_name ?? "")),
    [lots],
  );

  const lot: ColdStorageLot | undefined = eligibleLots.find((l) => l.id === lotId);
  const variationById = useMemo(() => new Map(variations.map((v) => [v.id, v])), [variations]);
  const sourceVariation = lot ? variationById.get(lot.variation_id) : undefined;

  // Candidate targets: same container class, not the source itself, and active.
  // Deliberately NOT filtered to smaller variations — a bigger target is a
  // build-up, which is half the point of this form.
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
          Repackage stock already in the cold room — a half keg split into sixtels, or three sixtels
          combined into a half keg. The beer stays in cold storage and stays on the same batch. Enter
          the number of units you actually filled; any volume lost along the way is recorded as
          shrinkage.
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

        <Field label="Transform into" required hint={lot ? undefined : "pick a source lot first"}>
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
          {/* "Units used" / "Units filled", not "cracked" / "filled" — the same
              two boxes have to read right whether three sixtels are becoming a
              half keg or the other way round. */}
          <Field label="Units used" required hint={lot ? `${lot.quantity_on_hand} on hand` : undefined}>
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
            That lot only holds {lot.quantity_on_hand}. You can&apos;t use more than is there.
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
              <span className="text-strong tabular-nums">{preview.volumeInFlOz.toLocaleString()} fl oz</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Volume out</span>
              <span className="text-strong tabular-nums">{preview.volumeOutFlOz.toLocaleString()} fl oz</span>
            </div>
            <div className="flex justify-between text-sm font-semibold border-t border-line-strong pt-2 mt-1">
              <span className="text-body">Shrinkage</span>
              {/* Within rounding the two sides genuinely tie — three sixtels
                  read as 1983 against a half keg's 1984 only because volumes are
                  stored in whole fl oz. Showing "0.000 bbl" there would be
                  false precision and "-0.000 bbl" would be nonsense. */}
              {preview.withinRoundingSlack ? (
                <span className="text-muted">none — volumes tie</span>
              ) : (
                <span className="text-accent tabular-nums">
                  {preview.shrinkageBbl.toFixed(3)} bbl ({(preview.shrinkageRatio * 100).toFixed(1)}%)
                </span>
              )}
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
