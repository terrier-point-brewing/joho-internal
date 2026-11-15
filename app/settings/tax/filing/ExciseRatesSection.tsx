"use client";

import { useExciseTaxRatesQuery } from "@/app/production/hooks/queries";
import type { ExciseTaxRate } from "@/app/production/types";
import ListTable from "@/app/components/ui/ListTable";

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
      <ListTable<(typeof rates)[number]>
        rows={rates}
        rowKey={(rate) => rate.id}
        zebra={false}
        empty="No excise tax rates configured."
        cols={[
          { key: "name", header: "Name", role: "label", className: "!font-normal !text-strong", cell: (rate) => rate.name },
          { key: "basis", header: "Basis", className: "text-secondary", cell: (rate) => BASIS_LABEL[rate.basis] },
          { key: "rate", header: "Rate", role: "headline", align: "right", className: "text-secondary tabular-nums", cell: (rate) => formatRate(rate) },
          { key: "party", header: "Party", className: "text-secondary", cell: (rate) => rate.receiving_party ?? rate.party_key },
        ]}
      />
    </section>
  );
}
