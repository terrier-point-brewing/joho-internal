"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, Field, ModalActions } from "./shared";
import { formatCurrency, formatUnitCost } from "@/lib/format";
import type { Ingredient } from "../types";
import type { IngredientUnit } from "@/lib/production/units";

interface ImpactResponse {
  ingredient: { id: string; name: string; unit: string; stock_quantity: number; cost_per_unit_usd: number | null };
  has_dependents: boolean;
  impact: {
    recipe_lines: number;
    open_commitments: number;
    past_adjustments: number;
    deposit_invoice_lines: number;
  };
  targets: IngredientUnit[];
  preview: { to_unit: string; ratio: number; stock_quantity: number; cost_per_unit_usd: number | null } | null;
}

function fmtQty(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/**
 * The one place an in-use ingredient's unit changes.
 *
 * Everything the confirm button will move is on screen before it is pressed —
 * the operator is agreeing to eight recipes being rewritten, so they should be
 * looking at the number eight. The row that says history stays put is there
 * for the same reason: a conversion restating what was already charged into a
 * batch would be the scarier outcome, and it is worth saying out loud that it
 * does not happen.
 */
export default function ConvertUnitModal({
  ingredient,
  onClose,
  onConverted,
}: {
  ingredient: Ingredient;
  onClose: () => void;
  onConverted: () => Promise<void> | void;
}) {
  const [toUnit, setToUnit] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Refetched per target so the preview arithmetic is the server's, not a
  // second implementation of it living in the browser.
  const { data, error } = useQuery({
    queryKey: ["production", "ingredient-unit-conversion", ingredient.id, toUnit],
    queryFn: async () => {
      const qs = toUnit ? `?to=${encodeURIComponent(toUnit)}` : "";
      const res = await fetch(`/api/production/ingredients/${ingredient.id}/convert-unit${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Could not load conversion details");
      return body as ImpactResponse;
    },
  });
  const loadError = error instanceof Error ? error.message : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!toUnit) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/production/ingredients/${ingredient.id}/convert-unit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_unit: toUnit }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Conversion failed");
      await onConverted();
      onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Conversion failed");
    } finally {
      setSubmitting(false);
    }
  }

  const preview = data?.preview ?? null;
  const targets = data?.targets ?? [];
  const cost = data?.ingredient.cost_per_unit_usd ?? null;

  return (
    <Modal title={`Change Unit — ${ingredient.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {loadError && (
          <p className="rounded border border-danger-border bg-danger-surface/30 px-3 py-2 text-xs text-danger">
            {loadError}
          </p>
        )}

        {!data && !loadError && <p className="text-xs text-faint">Loading…</p>}

        {data && targets.length === 0 && (
          <p className="rounded border border-line bg-surface/40 px-3 py-2 text-xs text-secondary">
            There is nothing to convert <strong>{ingredient.unit}</strong> into. A conversion needs another
            unit measuring the same thing with a fixed ratio to this one — pounds and ounces have that,
            pounds and liters do not.
          </p>
        )}

        {data && targets.length > 0 && (
          <>
            <Field label="Convert to" required>
              <select className="inp" value={toUnit} required onChange={(e) => setToUnit(e.target.value)}>
                <option value="">— select —</option>
                {targets.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
              </select>
            </Field>

            {preview && (
              <div className="rounded border border-line divide-y divide-line/60 text-sm">
                <Row label="Stock on hand">
                  <span className="tabular-nums text-secondary">
                    {fmtQty(data.ingredient.stock_quantity)} {data.ingredient.unit} →{" "}
                  </span>
                  <span className="tabular-nums text-body font-medium">
                    {fmtQty(preview.stock_quantity)} {preview.to_unit}
                  </span>
                </Row>
                <Row label="Cost per unit">
                  {cost == null ? (
                    <span className="text-disabled">—</span>
                  ) : (
                    <>
                      <span className="tabular-nums text-secondary">{formatUnitCost(cost)} → </span>
                      <span className="tabular-nums text-body font-medium">
                        {formatUnitCost(preview.cost_per_unit_usd ?? 0)}
                      </span>
                    </>
                  )}
                </Row>
                <Row label="Recipe lines">
                  <span className="tabular-nums text-body">
                    {data.impact.recipe_lines} rescaled ×{fmtQty(preview.ratio)}
                  </span>
                </Row>
                <Row label="Open commitments">
                  <span className="tabular-nums text-body">
                    {data.impact.open_commitments} rescaled ×{fmtQty(preview.ratio)}
                  </span>
                </Row>
                <Row label="Past adjustments">
                  <span className="text-secondary">
                    {data.impact.past_adjustments} unchanged — keep {data.ingredient.unit}
                  </span>
                </Row>
              </div>
            )}

            {preview && cost != null && (
              <p className="text-xs text-faint">
                Total value stays{" "}
                <span className="tabular-nums">
                  {formatCurrency(data.ingredient.stock_quantity * cost)}
                </span>
                . A conversion restates the numbers; it never moves value.
              </p>
            )}
          </>
        )}

        <ModalActions
          submitting={submitting}
          onCancel={onClose}
          label="Convert"
          disabled={!toUnit || !preview}
        />
      </form>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
