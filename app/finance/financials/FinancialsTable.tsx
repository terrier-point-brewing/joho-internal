"use client";

// Single MoM renderer for the consolidated Financials view. Replaces
// app/finance/sales/SalesTable.tsx, app/finance/statements/lib.tsx's MoM
// components, and the Balance-Sheet page's bespoke rows (deleted in Task 14
// once the Financials page is wired up) with one tree-walking table driven by
// buildTree.ts's TreeNode[]. Presentation only — all totals/rollups are
// precomputed by buildTree; this component just formats and toggles.

import { useCallback, useMemo, useState } from "react";
import { formatCurrencyCents, EM_DASH } from "@/lib/format";
import Badge from "@/app/components/ui/Badge";
import SortableTh from "@/app/components/ui/SortableTh";
import { amountPerBbl } from "@/lib/finance/financials/volume";
import { statementTotal, totalColumnLabel } from "@/lib/finance/financials/statementTotal";
import type { TotalMode } from "@/lib/finance/financials/statementTotal";
import type { BblCoverage, Channel, CoaAccountRef, FinancialsRow, Measure } from "@/lib/finance/financials/types";
import type { SortState } from "@/lib/table/types";
import { CHANNEL_COLOR, CHANNEL_LABEL } from "./channelColors";
import type { TreeNode } from "./buildTree";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(ym: string): string {
  const idx = Number(ym.slice(5, 7)) - 1;
  return MONTH_NAMES[idx] ?? ym;
}

/** Stable per-node key: coaId when the row has one, else the account/section label — prefixed with the parent's key so same-named nodes under different parents never collide. */
function nodeKey(node: TreeNode, parentPath: string): string {
  const id = node.row?.coaId ?? node.row?.accountName ?? node.label;
  return `${parentPath}/${id}`;
}

// Tailwind spacing-scale-only indent steps (docs/UI_STANDARD.md §3 bans
// arbitrary `pl-[Npx]` / inline style padding for tree indents) — clamps
// deeper nesting (channel slices under a sub-account) at the widest allowed step.
// Applied as a MARGIN on top of every row's shared `pl-4` base (see
// ACCOUNT_CELL_BASE) rather than as the label cell's only padding: a fixed
// base means a depth-1 account is always indented further than the
// (non-interactive) section header above it, and every deeper level is
// further still — previously depth-1's own `pl-2` (8px) was LESS than the
// section header's fixed `px-4` (16px), so top-level accounts rendered to
// the left of their own section, and depth-2 (`pl-4`, 16px) coincided
// exactly with the section header's inset.
const INDENT_STEPS = ["ml-2", "ml-4", "ml-6", "ml-8"] as const;
function indentClass(depth: number): string {
  return INDENT_STEPS[Math.min(Math.max(depth - 1, 0), INDENT_STEPS.length - 1)];
}

// Shared left inset for every row type's label cell (section headers,
// account rows, subtotal/total rows) — the one fixed reference point
// INDENT_STEPS' margins stack on top of for account rows.
const ACCOUNT_CELL_BASE = "pl-4";

// ── Measure-aware cell content ──────────────────────────────────────────────

function MoneyCell({ cents }: { cents: number }) {
  if (cents === 0) return <span className="text-faint">{EM_DASH}</span>;
  return <span className={cents < 0 ? "text-danger" : "text-strong"}>{formatCurrencyCents(cents)}</span>;
}

function BblCell({ bbl }: { bbl: number }) {
  if (bbl === 0) return <span className="text-faint">{EM_DASH}</span>;
  return <span className="text-strong">{bbl.toFixed(2)}</span>;
}

/** `$/BBL` cell. Per lib/finance/financials/volume.ts's amountPerBbl contract, a row whose
 * bblCoverage isn't "full" NEVER gets a computed ratio — render a flagged, muted marker
 * instead of a number so partial/unknown volume coverage can't silently read as a real $/BBL. */
function AmountPerBblCell({ amountCents, bbl, coverage }: { amountCents: number; bbl: number; coverage: BblCoverage }) {
  const { valueCents, flagged } = amountPerBbl(amountCents, bbl, coverage);
  if (flagged || valueCents === null) {
    return (
      <span title="Volume coverage incomplete — $/BBL withheld">
        <Badge tone="neutral" className="opacity-80">{EM_DASH}</Badge>
      </span>
    );
  }
  return <span className="text-strong">{formatCurrencyCents(valueCents)}</span>;
}

/**
 * A figure an operator stated, shown instead of the one this account's source
 * reported. Balance sheet only — see `statedMonths` on FinancialsRow.
 *
 * A dotted underline and a hover explanation rather than a badge: the figure is
 * the account's real balance and should read as one. What the mark says is only
 * that its BASIS is a person rather than the feed named against the account, so
 * a reader chasing a discrepancy against a bank statement knows where the number
 * came from instead of concluding the integration is broken.
 */
function StatedFigure({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="underline decoration-dotted decoration-from-font underline-offset-4"
      title="Entered by hand — overrides the feed"
    >
      {children}
    </span>
  );
}

function MeasureCell({ measure, row, month }: { measure: Measure; row: FinancialsRow | null; month: string }) {
  if (!row) return <span className="text-faint">{EM_DASH}</span>;
  if (measure === "bbl") return <BblCell bbl={row.bblByMonth[month] ?? 0} />;
  if (measure === "amount_per_bbl") {
    return <AmountPerBblCell amountCents={row.amountCentsByMonth[month] ?? 0} bbl={row.bblByMonth[month] ?? 0} coverage={row.bblCoverage} />;
  }
  const cell = <MoneyCell cents={row.amountCentsByMonth[month] ?? 0} />;
  return row.statedMonths?.includes(month) ? <StatedFigure>{cell}</StatedFigure> : cell;
}

function MeasureTotalCell({ measure, row, months, totalMode }: { measure: Measure; row: FinancialsRow | null; months: string[]; totalMode: TotalMode }) {
  if (!row) return <span className="text-faint">{EM_DASH}</span>;
  const totalCents = statementTotal(row.amountCentsByMonth, months, totalMode);
  // BBL follows the same rule: a balance sheet's volume figure, if ever shown,
  // is a position at period end, not a sum of positions.
  const totalBbl = statementTotal(row.bblByMonth, months, totalMode);
  if (measure === "bbl") return <BblCell bbl={totalBbl} />;
  if (measure === "amount_per_bbl") return <AmountPerBblCell amountCents={totalCents} bbl={totalBbl} coverage={row.bblCoverage} />;
  return <MoneyCell cents={totalCents} />;
}

/** Channel color chip (data-category exception — see channelColors.ts). Shown on leaf rows carrying a known channel: either a genuine channel-slice row, or a leaf account whose own postings are all one channel. */
function ChannelChip({ channel }: { channel: Channel }) {
  const c = CHANNEL_COLOR[channel];
  return (
    <Badge tone="none" className={`shrink-0 ${c.border} ${c.bg} ${c.text}`}>
      {CHANNEL_LABEL[channel]}
    </Badge>
  );
}

// ── Forecast columns ────────────────────────────────────────────────────────
//
// With the page's forecast toggle on, the columns read left to right as time
// does: the months that happened, the open month (actual so far plus what is
// still to come, tinted), the projected months (tinted, behind a rule), and
// then TWO period figures — the actual one, which is exactly the figure the
// statement shows with the toggle off, and the one that includes the forecast.
// Nothing projected is ever folded into a figure labelled actual.

/** "Jan ’27" — a forecast usually crosses a year end, so the year is always shown. */
function forecastMonthLabel(ym: string): string {
  return `${monthLabel(ym)} ’${ym.slice(2, 4)}`;
}

/** How a line's forecast was produced, for the cell's hover text. */
export type ForecastMethodLookup = (row: FinancialsRow) => string | undefined;

/** What the forecast adds to the table. Every row in `tree` must carry `restKey` and `months` as keys. */
export interface ForecastColumns {
  /** Projected months, after the open one. */
  months: string[];
  /** The month in progress, when the statement shows it; null otherwise (and then `restKey` is null too). */
  openMonth: string | null;
  /** The key rows carry the rest of the open month under. */
  restKey: string | null;
  methodFor?: ForecastMethodLookup;
}

const NO_FORECAST: ForecastColumns = { months: [], openMonth: null, restKey: null };

function forecastOn(f: ForecastColumns): boolean {
  return f.months.length > 0 || f.restKey !== null;
}

/**
 * The open month as it is expected to END. A flow adds what is still to come
 * to what has happened; a balance is simply the month-end balance.
 */
function openMonthCents(by: Record<string, number>, f: ForecastColumns, mode: TotalMode): number {
  const rest = f.restKey ? (by[f.restKey] ?? 0) : 0;
  return mode === "closing" ? rest : (f.openMonth ? (by[f.openMonth] ?? 0) : 0) + rest;
}

/** The period figure including the forecast: the sum through the last projected month, or the balance at it. */
function withForecastCents(by: Record<string, number>, months: string[], f: ForecastColumns, mode: TotalMode): number {
  if (mode === "closing") {
    const last = f.months[f.months.length - 1] ?? f.restKey ?? months[months.length - 1];
    return last === undefined ? 0 : (by[last] ?? 0);
  }
  return statementTotal(by, months, "sum") + (f.restKey ? (by[f.restKey] ?? 0) : 0) + f.months.reduce((sum, m) => sum + (by[m] ?? 0), 0);
}

const FORECAST_CELL = "px-2 text-right text-sm font-mono tabular-nums bg-accent-muted/20";
const FORECAST_FIRST = "border-l border-accent-border/50";
/** The open month is part actual, part forecast, so it is tinted more lightly than a fully projected month. */
const PART_FORECAST_CELL = "bg-accent-muted/10";

/** The actual month columns. The open month, with the forecast on, shows its expected month-end figure. */
function MonthCells({ row, months, measure, forecast, totalMode, className }: {
  row: FinancialsRow | null;
  months: string[];
  measure: Measure;
  forecast: ForecastColumns;
  totalMode: TotalMode;
  className: string;
}) {
  return (
    <>
      {months.map((m) => {
        const partForecast = forecast.restKey !== null && m === forecast.openMonth && measure === "amount" && row !== null;
        if (!partForecast) {
          return (
            <td key={m} className={`${className} px-2 text-right text-sm font-mono tabular-nums`}>
              <MeasureCell measure={measure} row={row} month={m} />
            </td>
          );
        }
        const actual = row.amountCentsByMonth[m] ?? 0;
        return (
          <td
            key={m}
            title={
              totalMode === "closing"
                ? `Forecast balance at month end — ${formatCurrencyCents(actual)} today`
                : `Forecast for the whole month — ${formatCurrencyCents(actual)} so far`
            }
            className={`${className} px-2 text-right text-sm font-mono tabular-nums ${PART_FORECAST_CELL}`}
          >
            <MoneyCell cents={openMonthCents(row.amountCentsByMonth, forecast, totalMode)} />
          </td>
        );
      })}
    </>
  );
}

function ForecastCells({ row, forecast, measure, className = "py-1.5" }: {
  row: FinancialsRow | null;
  forecast: ForecastColumns;
  measure: Measure;
  className?: string;
}) {
  const method = row && forecast.methodFor ? forecast.methodFor(row) : undefined;
  return (
    <>
      {forecast.months.map((m, i) => (
        <td
          key={`f-${m}`}
          title={method ? `Forecast — ${method}` : "Forecast"}
          className={`${className} ${FORECAST_CELL} ${i === 0 ? FORECAST_FIRST : ""}`}
        >
          {/* Only dollars are forecast; volume measures have no projected figure. */}
          {measure === "amount" && row
            ? <MoneyCell cents={row.amountCentsByMonth[m] ?? 0} />
            : <span className="text-faint">{EM_DASH}</span>}
        </td>
      ))}
    </>
  );
}

/** The period figure(s), always last: the actual one, then — with the forecast on — the one that includes it. */
function TotalCells({ row, months, measure, forecast, totalMode, className }: {
  row: FinancialsRow | null;
  months: string[];
  measure: Measure;
  forecast: ForecastColumns;
  totalMode: TotalMode;
  className: string;
}) {
  const on = forecastOn(forecast);
  return (
    <>
      <td className={`${className} pl-2 ${on ? "pr-2 border-l border-line-strong/60" : "pr-4"} text-right text-sm font-mono tabular-nums`}>
        <MeasureTotalCell measure={measure} row={row} months={months} totalMode={totalMode} />
      </td>
      {on && (
        <td title="Actual months plus the forecast" className={`${className} pl-2 pr-4 text-right text-sm font-mono tabular-nums bg-accent-muted/20`}>
          {measure === "amount" && row
            ? <MoneyCell cents={withForecastCents(row.amountCentsByMonth, months, forecast, totalMode)} />
            : <span className="text-faint">{EM_DASH}</span>}
        </td>
      )}
    </>
  );
}

// ── Row components ──────────────────────────────────────────────────────────

interface RowCommonProps {
  months: string[];
  forecast: ForecastColumns;
  totalMode: TotalMode;
  measure: Measure;
  isExpanded: (key: string, defaultExpanded: boolean) => boolean;
  toggle: (key: string) => void;
  /** coaId -> GL account number lookup; null (not just absent) when the "Show GL #" toggle is off, so account rows can skip reserving the column's width entirely. */
  glNumberByCoaId: Map<string, string | null> | null;
}

/** Fixed-width GL account number badge for an account row -- only rendered when the "Show GL #" toggle is on (see FinancialsTable's `glNumberByCoaId` prop). Blank (not omitted) when a row's coaId has no match (section/subtotal rows never have one; a real account always should), so every account label in the column still starts at the same x-offset. */
function GlNumberBadge({ coaId, glNumberByCoaId }: { coaId: string | null; glNumberByCoaId: Map<string, string | null> | null }) {
  if (!glNumberByCoaId) return null;
  const num = coaId ? glNumberByCoaId.get(coaId) : null;
  return <span className="w-10 shrink-0 text-right font-mono text-xs text-faint tabular-nums">{num ?? ""}</span>;
}

// Frozen label column: shared by the header th and every row's first td so the
// account name stays put while month/total columns scroll horizontally.
// Narrower on mobile (w-36) so the frozen column doesn't crowd out the
// scrolling month/total data on a phone-width viewport; full w-64 from `sm:`
// up, matching the pre-consolidation SalesTable's mobile fix.
const STICKY_LABEL_CELL = "sticky left-0 z-10 w-36 sm:w-64";

// Fixed-size, non-growing, centered expand/collapse slot -- shared by every
// row type (caret-bearing or not) so a row's own label always starts at the
// exact same x-offset as a sibling at the same depth, regardless of whether
// IT happens to have children (a caret glyph) or not (empty). Without a fixed
// box, a present vs. absent glyph can nudge one sibling's label a few px off
// from another's, reading as a depth mismatch even though both are correctly
// at the same tree depth.
const EXPAND_SLOT = "inline-flex w-3 shrink-0 items-center justify-center overflow-hidden leading-none";

/** A single account/sub-account/channel-slice row, recursing into its children when expanded. Depth >= 1 (top-level sections/subtotals are rendered separately). Collapsed by default (unlike sections) so opening a statement doesn't dump the entire CoA depth at once -- drilling into an account's sub-accounts/channel slices is opt-in per row. */
function AccountRow({ node, path, ...rest }: RowCommonProps & { node: TreeNode; path: string }) {
  const { months, measure, isExpanded, toggle, glNumberByCoaId, totalMode, forecast } = rest;
  const key = nodeKey(node, path);
  const expanded = isExpanded(key, false);
  const hasChildren = node.children.length > 0;
  const showChannelChip = !hasChildren && node.row !== null && node.row.channel !== "unknown";
  // An operator-entered exception broken out of its parent account (buildTree's
  // isAdjustment) renders italic -- label AND figures, via inheritance on the
  // <tr> -- so it reads at a glance as a manual line building INTO the account
  // above it rather than as one more real sub-account beside its siblings.
  const rowStyle = node.isAdjustment ? "italic" : "";

  return (
    <>
      <tr className={`border-t border-line/40 hover:bg-surface/20 ${rowStyle}`}>
        {/* line-clamp-2 (not truncate) below w-64: on a 144px mobile column, a
            deeply-nested account plus its indent margin can leave under 80px
            for the label, so a single-line truncation loses too much -- and a
            title-tooltip fallback doesn't work on a touch screen anyway. */}
        <td className={`py-1.5 pr-3 text-xs bg-surface ${STICKY_LABEL_CELL} ${ACCOUNT_CELL_BASE}`}>
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggle(key)}
              className={`w-full flex items-center gap-1.5 min-w-0 text-left hover:text-primary ${indentClass(node.depth)}`}
            >
              <span className={`${EXPAND_SLOT} text-faint text-xs`}>{expanded ? "▾" : "▸"}</span>
              <GlNumberBadge coaId={node.row?.coaId ?? null} glNumberByCoaId={glNumberByCoaId} />
              <span className="line-clamp-2 sm:truncate font-medium text-strong">{node.label}</span>
              {showChannelChip && node.row && <ChannelChip channel={node.row.channel} />}
            </button>
          ) : (
            <div className={`flex items-center gap-1.5 min-w-0 ${indentClass(node.depth)}`}>
              <span className={EXPAND_SLOT} />
              <GlNumberBadge coaId={node.row?.coaId ?? null} glNumberByCoaId={glNumberByCoaId} />
              <span className="line-clamp-2 sm:truncate text-secondary">{node.label}</span>
              {showChannelChip && node.row && <ChannelChip channel={node.row.channel} />}
            </div>
          )}
        </td>
        <MonthCells row={node.row} months={months} measure={measure} forecast={forecast} totalMode={totalMode} className="py-1.5" />
        <ForecastCells row={node.row} forecast={forecast} measure={measure} />
        <TotalCells row={node.row} months={months} measure={measure} forecast={forecast} totalMode={totalMode} className="py-1.5 font-semibold" />
      </tr>
      {expanded && node.children.map((child, i) => (
        <AccountRow key={nodeKey(child, key) + i} node={child} path={key} {...rest} />
      ))}
    </>
  );
}

/** Top-level section band (Revenue, COGS, Bank & Cash, ...): a static, non-interactive header (never a dropdown -- a section is a presentation grouping, not a real account, so it has nothing of its own to expand/collapse) + its account rows (each individually still collapsible via AccountRow) + a "Total {label}" footer computed from the section's own rolled-up row. */
function SectionBlock({ node, ...rest }: RowCommonProps & { node: TreeNode }) {
  const { months, measure, totalMode, forecast } = rest;
  const key = nodeKey(node, "root");
  const hasChildren = node.children.length > 0;

  return (
    <>
      <tr className="border-t border-line-strong/60 bg-surface">
        <td colSpan={months.length + 2 + forecast.months.length + (forecastOn(forecast) ? 1 : 0)} className="py-2 bg-surface">
          {/* This cell spans the full table width, so `sticky left-0` on the td
              itself can't pin anything (it already fills its own row). Instead
              pin a content-width (`w-fit`) inner div so the section title stays
              frozen on horizontal scroll, matching the data rows' frozen label
              column. The pl-4 inset lives here (not on the td) so the pinned
              title lines up with ACCOUNT_CELL_BASE. */}
          <div className={`flex items-center gap-2 w-fit sticky left-0 z-10 ${ACCOUNT_CELL_BASE}`}>
            <span className="text-xs font-semibold text-secondary uppercase tracking-wide">{node.label}</span>
            {!hasChildren && <span className="text-xs text-faint italic">no mapped transactions</span>}
          </div>
        </td>
      </tr>

      {node.children.map((child, i) => (
        <AccountRow key={nodeKey(child, key) + i} node={child} path={key} {...rest} />
      ))}

      <tr className="border-t border-line-strong/60 bg-surface">
        <td className={`py-1.5 pr-3 text-xs text-secondary font-medium bg-surface ${STICKY_LABEL_CELL} ${ACCOUNT_CELL_BASE}`}>Total {node.label}</td>
        <MonthCells row={node.row} months={months} measure={measure} forecast={forecast} totalMode={totalMode} className="py-1.5 font-semibold" />
        <ForecastCells row={node.row} forecast={forecast} measure={measure} className="py-1.5 font-semibold" />
        <TotalCells row={node.row} months={months} measure={measure} forecast={forecast} totalMode={totalMode} className="py-1.5 font-bold text-primary" />
      </tr>
    </>
  );
}

/** Top-level subtotal (Total Income, Gross Profit, Net Income, Total Cash In/Out, Net Operating, Total Assets/Liabilities/L+E, ...) — a single bold rollup line, no drill-down (its constituent sections already rendered their own detail above it). */
function PercentCell({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) return <span className="text-faint">{EM_DASH}</span>;
  return <span className={pct < 0 ? "text-danger" : "text-strong"}>{pct.toFixed(1)}%</span>;
}

/** numerator ÷ denominator over a set of column keys, in percent; null when the denominator is zero. */
function ratioOver(parts: TreeNode["ratioParts"], keys: string[]): number | null {
  if (!parts) return null;
  const sum = (by: Record<string, number>) => keys.reduce((total, k) => total + (by[k] ?? 0), 0);
  const den = sum(parts.denominator);
  return den === 0 ? null : (sum(parts.numerator) / den) * 100;
}

function SubtotalBar({ node, months, measure, totalMode: tableMode, forecast }: { node: TreeNode; months: string[]; measure: Measure; totalMode: TotalMode; forecast: ForecastColumns }) {
  const totalMode = node.totalMode ?? tableMode;
  const on = forecastOn(forecast);
  // A ratio line (Gross Profit %) has no cents figure and no $/BBL reading:
  // render its percentages whatever the measure, styled like a memo line.
  if (node.isRatio) {
    const restKeys = forecast.restKey ? [forecast.restKey] : [];
    return (
      <tr className="italic bg-surface-mid">
        <td className={`py-2 px-4 text-xs font-semibold text-primary bg-surface-mid ${STICKY_LABEL_CELL}`}>{node.label}</td>
        {months.map((m) => {
          const partForecast = forecast.restKey !== null && m === forecast.openMonth;
          return (
            <td key={m} className={`py-2 px-2 text-right text-sm font-mono tabular-nums font-semibold ${partForecast ? PART_FORECAST_CELL : ""}`}>
              <PercentCell pct={partForecast ? ratioOver(node.ratioParts, [m, ...restKeys]) : node.ratioByMonth?.[m]} />
            </td>
          );
        })}
        {forecast.months.map((m, i) => (
          <td key={`f-${m}`} title="Forecast" className={`py-2 font-semibold ${FORECAST_CELL} ${i === 0 ? FORECAST_FIRST : ""}`}>
            <PercentCell pct={node.ratioByMonth?.[m]} />
          </td>
        ))}
        <td className={`py-2 pl-2 ${on ? "pr-2 border-l border-line-strong/60" : "pr-4"} text-right text-sm font-mono tabular-nums font-bold text-primary`}>
          <PercentCell pct={node.ratioTotal} />
        </td>
        {on && (
          <td title="Actual months plus the forecast" className="py-2 pl-2 pr-4 text-right text-sm font-mono tabular-nums font-bold text-primary bg-accent-muted/20">
            <PercentCell pct={ratioOver(node.ratioParts, [...months, ...restKeys, ...forecast.months])} />
          </td>
        )}
      </tr>
    );
  }
  // A memo line (EBITDA) is a side calculation, not a figure the statement
  // chains through: italic, no heavy rule, so it can't be misread as the
  // next real subtotal.
  const memo = node.isMemo === true;
  return (
    <tr className={memo ? "italic bg-surface-mid" : "border-t-2 border-line-subtle bg-surface-mid"}>
      <td className={`py-2 px-4 text-xs font-semibold text-primary bg-surface-mid ${STICKY_LABEL_CELL}`}>{memo ? `${node.label} (memo)` : node.label}</td>
      <MonthCells row={node.row} months={months} measure={measure} forecast={forecast} totalMode={totalMode} className="py-2 font-semibold" />
      <ForecastCells row={node.row} forecast={forecast} measure={measure} className="py-2 font-semibold" />
      <TotalCells row={node.row} months={months} measure={measure} forecast={forecast} totalMode={totalMode} className="py-2 font-bold text-primary" />
    </tr>
  );
}

/** Sortable month/Total header cells only render as <SortableTh> when the caller
 * threads `sort`/`onSort` in (Task 11) — otherwise this falls back to the original
 * plain <th> so FinancialsTable stays usable uncontrolled. */
function TableHead({ months, sort, onSort, totalMode, forecast }: { months: string[]; sort?: SortState; onSort?: (key: string) => void; totalMode: TotalMode; forecast: ForecastColumns }) {
  const on = forecastOn(forecast);
  // The open month's figure is an estimate while the forecast is on, and says so.
  const headerLabel = (m: string) => (forecast.restKey !== null && m === forecast.openMonth ? `${monthLabel(m)} est.` : monthLabel(m));
  const totalLabel = totalColumnLabel(totalMode);
  const actualLabel = on ? (totalMode === "closing" ? `${totalLabel} today` : `${totalLabel} actual`) : totalLabel;
  return (
    <thead>
      <tr className="bg-surface border-b border-line sticky top-0 z-10">
        <th className="py-2 px-4 text-left text-xs text-muted uppercase tracking-wide font-semibold w-36 sm:w-64 sticky left-0 z-20 bg-surface">Account</th>
        {months.map((m) =>
          onSort ? (
            <SortableTh
              key={m}
              label={headerLabel(m)}
              sortKey={m}
              sort={sort ?? null}
              onSort={onSort}
              align="right"
              className="text-xs !text-muted !font-medium !px-2 !py-2 w-24 normal-case tracking-wide"
            />
          ) : (
            <th key={m} className="py-2 px-2 text-right text-xs text-muted uppercase tracking-wide font-medium w-24">
              {headerLabel(m)}
            </th>
          ),
        )}
        {forecast.months.map((m, i) => (
          <th
            key={`f-${m}`}
            title="Forecast"
            className={`py-2 px-2 text-right text-xs text-accent-soft font-medium w-24 tracking-wide whitespace-nowrap ${i === 0 ? FORECAST_FIRST : ""}`}
          >
            {forecastMonthLabel(m)}
            <span className="block text-faint font-normal">forecast</span>
          </th>
        ))}
        {onSort ? (
          <SortableTh
            label={actualLabel}
            sortKey="total"
            sort={sort ?? null}
            onSort={onSort}
            align="right"
            className={`text-xs !text-secondary !font-semibold !pl-2 ${on ? "!pr-2 border-l border-line-strong/60" : "!pr-4"} !py-2 w-28 normal-case tracking-wide`}
          />
        ) : (
          <th className={`py-2 pl-2 ${on ? "pr-2 border-l border-line-strong/60" : "pr-4"} text-right text-xs text-secondary uppercase tracking-wide font-semibold w-28`}>{actualLabel}</th>
        )}
        {on && (
          <th className="py-2 pl-2 pr-4 text-right text-xs text-accent-soft font-semibold w-28 tracking-wide whitespace-nowrap">
            {totalLabel}
            <span className="block text-faint font-normal">with forecast</span>
          </th>
        )}
      </tr>
    </thead>
  );
}

// ── Root component ───────────────────────────────────────────────────────────

interface FinancialsTableProps {
  tree: TreeNode[];
  months: string[];
  measure: Measure;
  /** `closing` for the balance sheet: its rows are point-in-time balances, so the period figure is the latest month, never a sum. Defaults to `sum` for flow statements. */
  totalMode?: TotalMode;
  onToggleExpand?: (key: string) => void;
  expandedKeys?: Set<string>;
  /** Task 11: current sort state + toggle handler for the Total/month <SortableTh> headers.
   * Both optional — omitting either falls back to plain, unsortable headers. */
  sort?: SortState;
  onSort?: (key: string) => void;
  /** coaId -> GL account number, for the "Show GL #" toggle. Omit (or pass []) when the toggle is off -- account rows then skip the GL# column entirely rather than rendering an all-blank one. */
  coaAccounts?: CoaAccountRef[];
  showGlNumbers?: boolean;
  /** The forecast's columns. Omit for a statement with no forecast on it. */
  forecast?: ForecastColumns;
}

export default function FinancialsTable({
  tree, months, measure, onToggleExpand, expandedKeys, sort, onSort, coaAccounts, showGlNumbers,
  totalMode = "sum", forecast = NO_FORECAST,
}: FinancialsTableProps) {
  const glNumberByCoaId = useMemo(
    () => (showGlNumbers ? new Map((coaAccounts ?? []).map((c) => [c.id, c.accountNumber])) : null),
    [showGlNumbers, coaAccounts],
  );

  // Uncontrolled fallback: track which keys have been clicked away from their
  // default state (sections default open, accounts default closed -- see
  // SectionBlock/AccountRow) when the caller doesn't pass expandedKeys/onToggleExpand.
  const [toggledKeys, setToggledKeys] = useState<Set<string>>(new Set());

  const isExpanded = useCallback(
    (key: string, defaultExpanded: boolean) =>
      expandedKeys ? expandedKeys.has(key) : defaultExpanded !== toggledKeys.has(key),
    [expandedKeys, toggledKeys],
  );

  const toggle = useCallback(
    (key: string) => {
      if (onToggleExpand) {
        onToggleExpand(key);
        return;
      }
      setToggledKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [onToggleExpand],
  );

  const minWidth = (months.length + forecast.months.length) * 96 + 280 + (forecastOn(forecast) ? 112 : 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs" style={{ minWidth: `${minWidth}px` }}>
        <TableHead months={months} sort={sort} onSort={onSort} totalMode={totalMode} forecast={forecast} />
        <tbody>
          {tree.map((node, i) => {
            const rowProps = { months, measure, isExpanded, toggle, glNumberByCoaId, totalMode, forecast };
            return node.isSection ? (
              <SectionBlock key={nodeKey(node, "root") + i} node={node} {...rowProps} />
            ) : (
              <SubtotalBar key={nodeKey(node, "root") + i} node={node} months={months} measure={measure} totalMode={totalMode} forecast={forecast} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
