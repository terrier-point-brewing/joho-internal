/**
 * What the operator changed between the generated invoice preview and what
 * was actually raised.
 *
 * The preview modal lets any line's quantity, price or description be edited,
 * lines be removed, and custom lines be added. Until now none of that left a
 * trace: the invoice showed the edited figures and nothing said they were not
 * what the system computed. This diff is stored on the invoice
 * (`invoices.line_edits`) with a required reason.
 *
 * Deposit lines the modal adds itself (the ingredient back-charge) are not
 * edits — the caller passes their ids so they are ignored. Pure.
 */

export interface EditableLine {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  squareCatalogVariationId?: string | null;
}

export interface LineEdit {
  kind: "changed" | "removed" | "added";
  description: string;
  before: { quantity: number; unitPriceCents: number; description: string } | null;
  after: { quantity: number; unitPriceCents: number; description: string } | null;
}

export function diffInvoiceLines(
  generated: EditableLine[],
  final: EditableLine[],
  ignoreIds: ReadonlySet<string> = new Set(),
): LineEdit[] {
  const edits: LineEdit[] = [];
  const finalById = new Map(final.map((l) => [l.id, l]));
  const generatedIds = new Set(generated.map((l) => l.id));

  for (const g of generated) {
    if (ignoreIds.has(g.id)) continue;
    const f = finalById.get(g.id);
    if (!f) {
      edits.push({ kind: "removed", description: g.description, before: snap(g), after: null });
      continue;
    }
    if (f.quantity !== g.quantity || f.unitPriceCents !== g.unitPriceCents || f.description !== g.description) {
      edits.push({ kind: "changed", description: g.description, before: snap(g), after: snap(f) });
    }
  }
  for (const f of final) {
    if (ignoreIds.has(f.id) || generatedIds.has(f.id)) continue;
    edits.push({ kind: "added", description: f.description, before: null, after: snap(f) });
  }
  return edits;
}

function snap(l: EditableLine) {
  return { quantity: l.quantity, unitPriceCents: l.unitPriceCents, description: l.description };
}

/** One-line summary for a badge: "2 lines changed, 1 removed". */
export function summarizeLineEdits(edits: LineEdit[]): string {
  const n = (k: LineEdit["kind"]) => edits.filter((e) => e.kind === k).length;
  const parts = [
    n("changed") ? `${n("changed")} changed` : null,
    n("removed") ? `${n("removed")} removed` : null,
    n("added") ? `${n("added")} added` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")} by hand` : "as generated";
}
