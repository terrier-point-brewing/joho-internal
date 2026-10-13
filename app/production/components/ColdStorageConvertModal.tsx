"use client";

import { useMemo, useState } from "react";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import { useColdStorageQuery, useRecipesQuery, usePackagingVariationsQuery, type ColdStorageLot } from "../hooks/queries";
import { baseMapOf, lineageDescendants } from "@/lib/production/recipeLineage";
import { unitsToBbl, validateUnits } from "@/lib/production/coldStorageRecipeConversion";

// Convert kegs or cans already sitting in cold storage into a different beer —
// the late-dose counterpart of an in-keg conversion. The operator picks the
// lot, the beer it became, and how many units. The server does the rest: a
// conversion child batch of the new recipe (reused if one exists), the ledger
// rows that move the volume across, the addition ingredients, the lot move,
// and the Square restatement for both beers.
//
// The target list is the lot's recipe's lineage DESCENDANTS — only a beer that
// is "based on" the one in the kegs can be charged for, because only then do
// the books know which lines the kegs already paid for. An unrelated beer is
// not offered; it is linked under Recipes → Based On first.

export default function ColdStorageConvertModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: lots = [], isPending: lotsLoading } = useColdStorageQuery();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: variations = [] } = usePackagingVariationsQuery();

  const [lotId, setLotId] = useState("");
  const [targetRecipeId, setTargetRecipeId] = useState("");
  const [units, setUnits] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligibleLots = useMemo(
    () =>
      lots
        .filter((l) => l.quantity_on_hand >= 1 && !!l.recipe_id)
        .sort((a, b) => (a.beer_name ?? "").localeCompare(b.beer_name ?? "")),
    [lots],
  );
  const lot: ColdStorageLot | undefined = eligibleLots.find((l) => l.id === lotId);

  const recipeById = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes]);
  const baseMap = useMemo(() => baseMapOf(recipes), [recipes]);
  const targets = useMemo(() => {
    if (!lot?.recipe_id) return [];
    return [...lineageDescendants(lot.recipe_id, baseMap)]
      .map((id) => recipeById.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .sort((a, b) => a.beer_name.localeCompare(b.beer_name));
  }, [lot, baseMap, recipeById]);
  const target = targets.find((r) => r.id === targetRecipeId);

  const variation = lot ? variations.find((v) => v.id === lot.variation_id) : undefined;
  const unitsNum = Number(units);
  const unitsError = lot && units !== "" ? validateUnits(unitsNum, lot.quantity_on_hand) : null;
  const volumeBbl = lot && variation && !unitsError && units !== "" ? unitsToBbl(unitsNum, Number(variation.total_volume_fl_oz)) : null;

  const blocked = !lot || !target || units === "" || !!unitsError;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/production/cold-storage/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lot_id: lotId,
          target_recipe_id: targetRecipeId,
          units: unitsNum,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not record that conversion.");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record that conversion.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Convert Cold Storage Stock" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted">
          Re-dose kegs or cans already in the cold room into a different beer. The stock stays in cold
          storage and moves to a conversion batch of the new recipe; the ingredients the new recipe adds
          are charged to that batch, and the original batch is credited back the beer it gave up.
        </p>

        <Field label="Source lot" required>
          <select
            className="inp w-full"
            value={lotId}
            onChange={(e) => {
              setLotId(e.target.value);
              setTargetRecipeId("");
              setUnits("");
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

        <Field
          label="Convert into"
          required
          hint={lot && targets.length === 0 ? "no recipe is based on this beer — link one under Recipes → Based On" : undefined}
        >
          <select
            className="inp w-full"
            value={targetRecipeId}
            onChange={(e) => setTargetRecipeId(e.target.value)}
            disabled={!lot || targets.length === 0}
          >
            <option value="">{lot ? "Select a beer…" : "—"}</option>
            {targets.map((r) => (
              <option key={r.id} value={r.id}>
                {r.beer_name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Units" required hint={lot ? `${lot.quantity_on_hand} on hand` : undefined}>
          <input
            type="number"
            min="1"
            step="1"
            className="inp w-full"
            value={units}
            onChange={(e) => setUnits(e.target.value)}
            disabled={!target}
          />
        </Field>

        {unitsError && <Banner tone="danger">{unitsError}</Banner>}

        {lot && target && volumeBbl != null && (
          <div className="rounded-lg bg-surface border border-line p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted">Volume converted</span>
              <span className="text-strong tabular-nums">{volumeBbl.toFixed(3)} bbl</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Becomes</span>
              <span className="text-strong">{target.beer_name}</span>
            </div>
            <p className="text-xs text-muted pt-1">
              Lands on {target.beer_name}&apos;s conversion batch of {lot.batch_number ?? "this batch"} — reused if one
              already exists, otherwise created and completed now.
            </p>
          </div>
        )}

        <Field label="Note" hint="what was added, when — e.g. dosed with grape juice 10/12">
          <input
            type="text"
            className="inp w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional"
          />
        </Field>

        {error && <Banner tone="danger">{error}</Banner>}

        <ModalActions submitting={submitting} onCancel={onClose} label="Convert Stock" disabled={blocked} />
      </form>
    </Modal>
  );
}
