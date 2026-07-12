"use client";

import Card from "@/app/components/ui/Card";
import type { ReferenceSpec } from "@/lib/tax/types";

/**
 * Read-only disclosure of a party's statutory reference data
 * (`TaxPartyTemplate.referenceView` — e.g. NC DOR's state rate + county
 * tier chart in lib/tax/parties/ncDorSalesUse/template.ts) so a filer can
 * audit exactly what rates/tiers the worksheet calc uses without having to
 * read the source. Purely presentational — the values themselves are
 * statutory constants, never editable here.
 */
export default function ReferenceDisclosure({ referenceView }: { referenceView: ReferenceSpec }) {
  if (referenceView.tables.length === 0 && (!referenceView.notes || referenceView.notes.length === 0)) return null;

  return (
    <div className="flex flex-col gap-4">
      {referenceView.tables.map((table) => (
        <Card key={table.title} padding="p-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-faint px-4 pt-3 pb-2">{table.title}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-t border-b border-line text-left">
                  {table.columns.map((col) => (
                    <th key={col} className="px-4 py-1.5 font-medium text-secondary whitespace-nowrap">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className="px-4 py-1.5 text-body whitespace-nowrap">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
                {table.rows.length === 0 && (
                  <tr>
                    <td className="px-4 py-2 text-faint" colSpan={table.columns.length}>
                      No reference rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {referenceView.notes && referenceView.notes.length > 0 && (
        <Card padding="p-3">
          <ul className="list-disc pl-4 space-y-1 text-xs text-muted">
            {referenceView.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
