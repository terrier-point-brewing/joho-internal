"use client";

// Spend Watch tab on the Financials page: which expense accounts moved this
// month against their trailing average, on either the accrual (P&L) or cash
// basis. Presentation only -- every number comes from
// lib/finance/financials/spendWatch.ts over the same statement rows the P&L
// and Cash Flow tabs render, so a figure here can never disagree with the
// column it summarises.

import { useMemo, useState } from "react";
import { formatCurrencyCents, formatPercent, EM_DASH } from "@/lib/format";
import type { FinancialsResponse, StatementKind } from "@/lib/finance/financials/types";
import { buildSpendWatch, type SpendMover, type MoverKind } from "@/lib/finance/financials/spendWatch";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import ToggleChip from "@/app/components/ui/ToggleChip";
import ButtonGroup from "@/app/components/ButtonGroup";
import type { TabDef } from "@/app/components/TabBar";

export type SpendBasis = Extract<StatementKind, "pl" | "cash_flow">;

const BASIS_TABS: TabDef<SpendBasis>[] = [
  { key: "pl",        label: "Accrual (P&L)" },
  { key: "cash_flow", label: "Cash" },
];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(ym: string): string {
  const idx = Number(ym.slice(5, 7)) - 1;
  return `${MONTH_NAMES[idx] ?? ym} ${ym.slice(0, 4)}`;
}

const KIND_LABEL: Record<MoverKind, { text: string; tone: "danger" | "success" | "neutral" | "info" }> = {
  up:      { text: "Up",      tone: "danger" },
  down:    { text: "Down",    tone: "success" },
  new:     { text: "New",     tone: "info" },
  stopped: { text: "Stopped", tone: "neutral" },
};

function signed(cents: number): string {
  return `${cents > 0 ? "+" : ""}${formatCurrencyCents(cents)}`;
}

function DeltaCell({ m }: { m: SpendMover }) {
  if (m.deltaCents === 0) return <span className="text-faint">{EM_DASH}</span>;
  const cls = m.deltaCents > 0 ? "text-danger" : "text-success";
  return (
    <span className={cls}>
      {signed(m.deltaCents)}
      {m.deltaPct != null && (
        <span className="text-xs text-muted ml-1">({m.deltaPct > 0 ? "+" : ""}{formatPercent(m.deltaPct / 100, 0)})</span>
      )}
    </span>
  );
}

function Tile({ label, value, sub, tone, title }: { label: string; value: string; sub?: string; tone?: "danger" | "success"; title?: string }) {
  const valueCls = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-primary";
  return (
    <Card padding="p-3" className="flex flex-col gap-1 min-w-0" title={title}>
      <span className="text-xs text-muted uppercase tracking-wide truncate">{label}</span>
      <span className={`text-base sm:text-xl font-semibold font-mono tabular-nums ${valueCls}`}>{value}</span>
      {sub && <span className="text-xs text-muted truncate">{sub}</span>}
    </Card>
  );
}

export default function SpendWatchTab({
  data,
  basis,
  onBasisChange,
  openMonth,
  focusMonth,
  onFocusMonthChange,
}: {
  data: FinancialsResponse;
  basis: SpendBasis;
  onBasisChange: (b: SpendBasis) => void;
  /** "YYYY-MM" of today in the brewery's zone -- the month still in progress. */
  openMonth: string;
  focusMonth: string;
  onFocusMonthChange: (m: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const result = useMemo(
    () => buildSpendWatch(data.rows, data.months, focusMonth, { coaAccounts: data.coaAccounts }),
    [data, focusMonth],
  );

  const flagged = result.movers.filter((m) => m.flagged);
  const visible = showAll ? result.movers : flagged;
  const upCount = flagged.filter((m) => m.kind === "up" || m.kind === "new").length;
  const totalDelta = result.totalFocusCents - result.totalBaselineCents;
  const totalPct = result.totalBaselineCents !== 0 ? totalDelta / Math.abs(result.totalBaselineCents) : null;
  const baselineLabel = result.baselineMonths.length > 0
    ? `${result.baselineMonths.length}-month average`
    : "no earlier months";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <ButtonGroup tabs={BASIS_TABS} activeKey={basis} onSelect={onBasisChange} />
          <span
            className="text-xs text-muted cursor-help"
            title="Accrual counts a bill in the month it belongs to; cash counts it when paid, so bills settled early the next month swing between months. Judge spend on accrual."
            aria-label="Accrual vs cash"
          >
            ⓘ
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted mr-0.5">Month:</span>
          {data.months.map((m) => (
            <ToggleChip key={m} active={m === focusMonth} onClick={() => onFocusMonthChange(m)}>
              {MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m}
              {m === openMonth && (
                <span className="text-2xs opacity-70 ml-1" title="Month in progress: month-to-date against full months, so most accounts read low">
                  · partial
                </span>
              )}
            </ToggleChip>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile
          label={`Spend · ${monthLabel(focusMonth)}`}
          value={formatCurrencyCents(result.totalFocusCents)}
          sub={`vs ${formatCurrencyCents(result.totalBaselineCents)} ${baselineLabel}`}
        />
        <Tile
          label="Change vs average"
          value={result.baselineMonths.length === 0 ? EM_DASH : signed(totalDelta)}
          sub={totalPct == null ? undefined : `${totalPct > 0 ? "+" : ""}${formatPercent(totalPct, 1)}`}
          tone={totalDelta > 0 ? "danger" : totalDelta < 0 ? "success" : undefined}
        />
        <Tile
          label="Accounts up"
          value={String(upCount)}
          title="Counted when ≥ $250 and ≥ 15% over the average"
          tone={upCount > 0 ? "danger" : undefined}
        />
        <Tile
          label="New spend"
          value={formatCurrencyCents(result.newSpend.reduce((s, m) => s + m.focusCents, 0))}
          sub={`${result.newSpend.length} ${result.newSpend.length === 1 ? "account" : "accounts"} with nothing in the ${baselineLabel}`}
        />
      </div>

      <div className="bg-surface border border-line rounded-lg overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-line">
          <span className="text-sm font-semibold text-strong">
            {showAll ? "All spend accounts" : "Movers"}
            <span className="text-xs text-muted font-normal ml-2">
              {visible.length} {visible.length === 1 ? "account" : "accounts"}
            </span>
          </span>
          <ToggleChip active={showAll} onClick={() => setShowAll((v) => !v)}>Show all accounts</ToggleChip>
        </div>

        {visible.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            {result.movers.length === 0
              ? "No spend recorded for this month."
              : "Nothing moved more than $250 and 15% against its average."}
          </p>
        ) : (
          <div className="scroll-x">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-2xs uppercase tracking-wide text-muted border-b border-line">
                  <th className="text-left px-4 py-2 font-medium">Account</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">{monthLabel(focusMonth)}</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Average</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Change</th>
                  <th className="text-right px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => (
                  <tr key={m.coaId} className="border-t border-line/40 hover:bg-surface/20">
                    <td className="px-4 py-2 min-w-0">
                      <div className="flex flex-col min-w-0">
                        <span className="font-medium text-strong truncate">
                          {m.accountNumber && <span className="font-mono text-xs text-faint mr-2">{m.accountNumber}</span>}
                          {m.shortName}
                        </span>
                        {m.groupName && <span className="text-xs text-muted truncate">{m.groupName}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-strong">{formatCurrencyCents(m.focusCents)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-secondary">
                      {result.baselineMonths.length === 0 ? EM_DASH : formatCurrencyCents(m.baselineCents)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap"><DeltaCell m={m} /></td>
                    <td className="px-4 py-2 text-right">
                      <Badge tone={KIND_LABEL[m.kind].tone}>{KIND_LABEL[m.kind].text}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
