"use client";

import { useExciseTaxRatesQuery } from "@/app/production/hooks/queries";
import type { ExciseTaxRate } from "@/app/production/types";
import Card from "@/app/components/ui/Card";

const BASIS_LABEL: Record<ExciseTaxRate["basis"], string> = {
  per_gallon: "per gallon",
  per_bbl: "per barrel",
  percent: "percent",
};

function formatRate(rate: ExciseTaxRate): string {
  if (rate.basis === "percent") return `${(rate.rate * 100).toFixed(2)}%`;
  return `$${rate.rate.toFixed(4)}`;
}

/**
 * Read-only excise-rate table, shared between production Export Settings
 * (all rows) and Finance → Settings → Tax Filing (scoped to one authority
 * via `partyKey`). Rates are fixed canonical data from `tax_rates` — this
 * view has no create/edit/delete affordances.
 */
export default function ExciseRatesSection({ partyKey }: { partyKey?: string }) {
  const { data: rates = [] } = useExciseTaxRatesQuery(partyKey);

  return (
    <section>
      <h3 className="text-sm font-medium text-strong mb-2">Excise Tax Rates</h3>
      <Card padding="">
        <div className="overflow-x-auto rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Name</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Basis</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted text-right">Rate</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Party</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((rate) => (
                <tr key={rate.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 text-strong">{rate.name}</td>
                  <td className="px-4 py-2.5 text-secondary">{BASIS_LABEL[rate.basis]}</td>
                  <td className="px-4 py-2.5 text-right text-secondary">{formatRate(rate)}</td>
                  <td className="px-4 py-2.5 text-secondary">
                    {rate.receiving_party ?? rate.party_key ?? <span className="text-disabled">—</span>}
                  </td>
                </tr>
              ))}
              {rates.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-center text-muted">
                    No excise tax rates configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
