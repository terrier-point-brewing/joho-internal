"use client";

import { useMemo, useState } from "react";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import { usePackagingVariationsQuery, useRecipesQuery } from "../hooks/queries";

// Record beer bought from another brewery (guest beer) as on hand in cold
// storage. It is NOT a brew: the units land on a purchased placeholder batch
// with volume 0, so produced volume, yields and the excise record do not move.
// The beer was tax-paid by whoever made it; we only sell it.
//
// Supplier, cost and date are the operator's record of the delivery
// (beer_receipts). The purchase itself is booked by the expense feed.

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ReceiveBeerModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: recipes = [], isPending: recipesLoading } = useRecipesQuery();
  const { data: variations = [] } = usePackagingVariationsQuery();

  const [recipeId, setRecipeId] = useState("");
  const [variationId, setVariationId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [supplier, setSupplier] = useState("");
  const [costUsd, setCostUsd] = useState("");
  const [receivedOn, setReceivedOn] = useState(todayIso);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedRecipes = useMemo(
    () => [...recipes].sort((a, b) => a.beer_name.localeCompare(b.beer_name)),
    [recipes],
  );

  // Finished-goods packaging only: a keg or a can SKU. Anything else is not a
  // thing the cold room holds.
  const targets = useMemo(
    () =>
      variations
        .filter((v) => v.is_active && (v.container?.type === "keg" || v.container?.type === "can"))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [variations],
  );

  const qtyNum = Number(quantity);
  const qtyOk = Number.isFinite(qtyNum) && qtyNum > 0;
  const costNum = costUsd.trim() === "" ? null : Number(costUsd);
  const costOk = costNum === null || (Number.isFinite(costNum) && costNum >= 0);
  const blocked = !recipeId || !variationId || !qtyOk || !costOk || !receivedOn;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/production/cold-storage/receive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: recipeId,
          variation_id: variationId,
          quantity: qtyNum,
          supplier: supplier.trim() || null,
          cost_usd: costNum,
          received_on: receivedOn,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not record that delivery.");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record that delivery.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Receive Purchased Beer" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted">
          Beer bought from another brewery, going into cold storage. It is booked as on hand only —
          not as a brew — so batch yields and the excise record are untouched. It sells through the
          taproom and Export Bay exactly like house stock.
        </p>

        <Field label="Beer" required>
          <select className="inp w-full" value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
            <option value="">{recipesLoading ? "Loading…" : "Select a beer…"}</option>
            {sortedRecipes.map((r) => (
              <option key={r.id} value={r.id}>{r.beer_name}</option>
            ))}
          </select>
        </Field>

        <Field label="Packaging" required>
          <select className="inp w-full" value={variationId} onChange={(e) => setVariationId(e.target.value)}>
            <option value="">Select packaging…</option>
            {targets.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Units received" required hint="kegs or cases, as packaged">
            <input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              className="inp w-full"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
          <Field label="Received on" required>
            <input
              type="date"
              className="inp w-full"
              value={receivedOn}
              onChange={(e) => setReceivedOn(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Supplier" hint="the brewery it came from">
            <input
              type="text"
              className="inp w-full"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              placeholder="Optional"
            />
          </Field>
          <Field label="Total cost ($)" hint="for this delivery, if known">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              className="inp w-full"
              value={costUsd}
              onChange={(e) => setCostUsd(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>

        <Field label="Note">
          <input
            type="text"
            className="inp w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional"
          />
        </Field>

        {!costOk && <Banner tone="danger">Cost must be a non-negative dollar amount.</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}

        <ModalActions submitting={submitting} onCancel={onClose} label="Receive Beer" disabled={blocked} />
      </form>
    </Modal>
  );
}
