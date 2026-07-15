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

function MeasureCell({ measure, row, month }: { measure: Measure; row: FinancialsRow | null; month: string }) {
  if (!row) return <span className="text-faint">{EM_DASH}</span>;
  if (measure === "bbl") return <BblCell bbl={row.bblByMonth[month] ?? 0} />;
  if (measure === "amount_per_bbl") {
    return <AmountPerBblCell amountCents={row.amountCentsByMonth[month] ?? 0} bbl={row.bblByMonth[month] ?? 0} coverage={row.bblCoverage} />;
  }
  return <MoneyCell cents={row.amountCentsByMonth[month] ?? 0} />;
}

function MeasureTotalCell({ measure, row, months }: { measure: Measure; row: FinancialsRow | null; months: string[] }) {
  if (!row) return <span className="text-faint">{EM_DASH}</span>;
  const totalCents = months.reduce((s, m) => s + (row.amountCentsByMonth[m] ?? 0), 0);
  const totalBbl = months.reduce((s, m) => s + (row.bblByMonth[m] ?? 0), 0);
  if (measure === "bbl") return <BblCell bbl={totalBbl} />;
  if (measure === "amount_per_bbl") return <AmountPerBblCell amountCents={totalCents} bbl={totalBbl} coverage={row.bblCoverage} />;
  return <MoneyCell cents={totalCents} />;
}

/** Channel color chip (data-category exception — see channelColors.ts). Shown on leaf rows carrying a known channel: either a genuine channel-slice row, or a leaf account whose own postings are all one channel. */
function ChannelChip({ channel }: { channel: Channel }) {
  const c = CHANNEL_COLOR[channel];
  return (
    <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full border border-line-subtle ${c.bg} ${c.text}`}>
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

// ── Row components ──────────────────────────────────────────────────────────

interface RowCommonProps {
  months: string[];
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
const STICKY_LABEL_CELL = "sticky left-0 z-10";

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
  const { months, measure, isExpanded, toggle, glNumberByCoaId } = rest;
  const key = nodeKey(node, path);
  const expanded = isExpanded(key, false);
  const hasChildren = node.children.length > 0;
  const showChannelChip = !hasChildren && node.row !== null && node.row.channel !== "unknown";

  return (
    <>
      <tr className="border-t border-line/40 hover:bg-surface/20">
        <td className={`py-1.5 pr-3 text-xs bg-surface ${STICKY_LABEL_CELL} ${ACCOUNT_CELL_BASE}`}>
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggle(key)}
              className={`w-full flex items-center gap-1.5 min-w-0 text-left hover:text-primary ${indentClass(node.depth)}`}
            >
              <span className={`${EXPAND_SLOT} text-faint text-xs`}>{expanded ? "▾" : "▸"}</span>
              <GlNumberBadge coaId={node.row?.coaId ?? null} glNumberByCoaId={glNumberByCoaId} />
              <span className="truncate font-medium text-strong">{node.label}</span>
              {showChannelChip && node.row && <ChannelChip channel={node.row.channel} />}
            </button>
          ) : (
            <div className={`flex items-center gap-1.5 min-w-0 ${indentClass(node.depth)}`}>
              <span className={EXPAND_SLOT} />
              <GlNumberBadge coaId={node.row?.coaId ?? null} glNumberByCoaId={glNumberByCoaId} />
              <span className="truncate text-secondary">{node.label}</span>
              {showChannelChip && node.row && <ChannelChip channel={node.row.channel} />}
            </div>
          )}
        </td>
        {months.map((m) => (
          <td key={m} className="py-1.5 px-2 text-right text-sm font-mono tabular-nums">
            <MeasureCell measure={measure} row={node.row} month={m} />
          </td>
        ))}
        <td className="py-1.5 pl-2 pr-4 text-right text-sm font-mono tabular-nums font-semibold">
          <MeasureTotalCell measure={measure} row={node.row} months={months} />
        </td>
      </tr>
      {expanded && node.children.map((child, i) => (
        <AccountRow key={nodeKey(child, key) + i} node={child} path={key} {...rest} />
      ))}
    </>
  );
}

/** Top-level section band (Revenue, COGS, Bank & Cash, ...): a static, non-interactive header (never a dropdown -- a section is a presentation grouping, not a real account, so it has nothing of its own to expand/collapse) + its account rows (each individually still collapsible via AccountRow) + a "Total {label}" footer computed from the section's own rolled-up row. */
function SectionBlock({ node, ...rest }: RowCommonProps & { node: TreeNode }) {
  const { months, measure } = rest;
  const key = nodeKey(node, "root");
  const hasChildren = node.children.length > 0;

  return (
    <>
      <tr className="border-t border-line-strong/60 bg-surface/60">
        <td colSpan={months.length + 2} className={`py-2 bg-surface/60 ${STICKY_LABEL_CELL} ${ACCOUNT_CELL_BASE}`}>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-secondary uppercase tracking-wide">{node.label}</span>
            {!hasChildren && <span className="text-xs text-faint italic">no mapped transactions</span>}
          </div>
        </td>
      </tr>

      {node.children.map((child, i) => (
        <AccountRow key={nodeKey(child, key) + i} node={child} path={key} {...rest} />
      ))}

      <tr className="border-t border-line-strong/60 bg-surface/40">
        <td className={`py-1.5 pr-3 text-xs text-secondary font-medium bg-surface/40 ${STICKY_LABEL_CELL} ${ACCOUNT_CELL_BASE}`}>Total {node.label}</td>
        {months.map((m) => (
          <td key={m} className="py-1.5 px-2 text-right text-sm font-mono tabular-nums font-semibold">
            <MeasureCell measure={measure} row={node.row} month={m} />
          </td>
        ))}
        <td className="py-1.5 pl-2 pr-4 text-right text-sm font-mono tabular-nums font-bold text-primary">
          <MeasureTotalCell measure={measure} row={node.row} months={months} />
        </td>
      </tr>
    </>
  );
}

/** Top-level subtotal (Total Income, Gross Profit, Net Income, Total Cash In/Out, Net Operating, Total Assets/Liabilities/L+E, ...) — a single bold rollup line, no drill-down (its constituent sections already rendered their own detail above it). */
function SubtotalBar({ node, months, measure }: { node: TreeNode; months: string[]; measure: Measure }) {
  return (
    <tr className="border-t-2 border-line-subtle bg-surface-mid/50">
      <td className={`py-2 px-4 text-xs font-semibold text-primary bg-surface-mid/50 ${STICKY_LABEL_CELL}`}>{node.label}</td>
      {months.map((m) => (
        <td key={m} className="py-2 px-2 text-right text-sm font-mono tabular-nums font-semibold">
          <MeasureCell measure={measure} row={node.row} month={m} />
        </td>
      ))}
      <td className="py-2 pl-2 pr-4 text-right text-sm font-mono tabular-nums font-bold text-primary">
        <MeasureTotalCell measure={measure} row={node.row} months={months} />
      </td>
    </tr>
  );
}

/** Sortable month/Total header cells only render as <SortableTh> when the caller
 * threads `sort`/`onSort` in (Task 11) — otherwise this falls back to the original
 * plain <th> so FinancialsTable stays usable uncontrolled. */
function TableHead({ months, sort, onSort }: { months: string[]; sort?: SortState; onSort?: (key: string) => void }) {
  return (
    <thead>
      <tr className="bg-surface border-b border-line sticky top-0 z-10">
        <th className="py-2 px-4 text-left text-xs text-muted uppercase tracking-wide font-semibold w-64 sticky left-0 z-20 bg-surface">Account</th>
        {months.map((m) =>
          onSort ? (
            <SortableTh
              key={m}
              label={monthLabel(m)}
              sortKey={m}
              sort={sort ?? null}
              onSort={onSort}
              align="right"
              className="text-xs !text-muted !font-medium !px-2 !py-2 w-24 normal-case tracking-wide"
            />
          ) : (
            <th key={m} className="py-2 px-2 text-right text-xs text-muted uppercase tracking-wide font-medium w-24">
              {monthLabel(m)}
            </th>
          ),
        )}
        {onSort ? (
          <SortableTh
            label="Total"
            sortKey="total"
            sort={sort ?? null}
            onSort={onSort}
            align="right"
            className="text-xs !text-secondary !font-semibold !pl-2 !pr-4 !py-2 w-28 normal-case tracking-wide"
          />
        ) : (
          <th className="py-2 pl-2 pr-4 text-right text-xs text-secondary uppercase tracking-wide font-semibold w-28">Total</th>
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
  onToggleExpand?: (key: string) => void;
  expandedKeys?: Set<string>;
  /** Task 11: current sort state + toggle handler for the Total/month <SortableTh> headers.
   * Both optional — omitting either falls back to plain, unsortable headers. */
  sort?: SortState;
  onSort?: (key: string) => void;
  /** coaId -> GL account number, for the "Show GL #" toggle. Omit (or pass []) when the toggle is off -- account rows then skip the GL# column entirely rather than rendering an all-blank one. */
  coaAccounts?: CoaAccountRef[];
  showGlNumbers?: boolean;
}

export default function FinancialsTable({
  tree, months, measure, onToggleExpand, expandedKeys, sort, onSort, coaAccounts, showGlNumbers,
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

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs" style={{ minWidth: `${months.length * 96 + 280}px` }}>
        <TableHead months={months} sort={sort} onSort={onSort} />
        <tbody>
          {tree.map((node, i) => {
            const rowProps = { months, measure, isExpanded, toggle, glNumberByCoaId };
            return node.isSection ? (
              <SectionBlock key={nodeKey(node, "root") + i} node={node} {...rowProps} />
            ) : (
              <SubtotalBar key={nodeKey(node, "root") + i} node={node} months={months} measure={measure} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
