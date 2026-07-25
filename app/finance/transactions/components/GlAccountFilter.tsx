"use client";

import AccountSelect, { type CoARef } from "../../AccountSelect";

/**
 * GL-account filter for the Transactions ledgers.
 *
 * Wraps AccountSelect rather than FilterSelect: the chart of accounts runs to
 * ~126 rows, which is unusable as a flat <select>, and AccountSelect already
 * provides the searchable, grouped picker used everywhere else in Finance.
 * Laid out to match FilterSelect so it sits in a FilterBar without standing out.
 */
export default function GlAccountFilter({
  accounts,
  value,
  onChange,
  className = "w-auto min-w-[200px]",
}: {
  accounts: CoARef[];
  /** Selected chart_of_accounts id, or null for "all accounts". */
  value: string | null;
  onChange: (coaId: string | null) => void;
  className?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="text-xs text-muted shrink-0">GL account:</span>
      <AccountSelect
        value={value}
        onChange={onChange}
        accounts={accounts}
        placeholder="All accounts"
        shortLabel
        className={className}
      />
    </label>
  );
}
