"use client";

// Single MoM renderer for the consolidated Financials view. Replaces
// app/finance/sales/SalesTable.tsx, app/finance/statements/lib.tsx's MoM
// components, and the Balance-Sheet page's bespoke rows (deleted in Task 14
// once the Financials page is wired up) with one tree-walking table driven by
// buildTree.ts's TreeNode[]. Presentation only — all totals/rollups are
// precomputed by buildTree; this component just formats and toggles.

import { useCallback, useState } from "react";
import { formatCurrencyCents, EM_DASH } from "@/lib/format";
import Badge from "@/app/components/ui/Badge";
import { amountPerBbl } from "@/lib/finance/financials/volume";
import type { BblCoverage, Channel, FinancialsRow, Measure } from "@/lib/finance/financials/types";
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
const INDENT_STEPS = ["pl-2", "pl-4", "pl-6", "pl-8"] as const;
function indentClass(depth: number): string {
  return INDENT_STEPS[Math.min(Math.max(depth - 1, 0), INDENT_STEPS.length - 1)];
}

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
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
}

/** A single account/sub-account/channel-slice row, recursing into its children when expanded. Depth >= 1 (top-level sections/subtotals are rendered separately). */
function AccountRow({ node, path, ...rest }: RowCommonProps & { node: TreeNode; path: string }) {
  const { months, measure, isExpanded, toggle } = rest;
  const key = nodeKey(node, path);
  const expanded = isExpanded(key);
  const hasChildren = node.children.length > 0;
  const showChannelChip = !hasChildren && node.row !== null && node.row.channel !== "unknown";

  return (
    <>
      <tr className="border-t border-line/40 hover:bg-surface/20">
        <td className={`py-1.5 pr-3 text-xs ${indentClass(node.depth)}`}>
          <div className="flex items-center gap-1.5 min-w-0">
            {hasChildren ? (
              <button type="button" onClick={() => toggle(key)} className="text-faint hover:text-secondary w-3 shrink-0 text-xs">
                {expanded ? "▾" : "▸"}
              </button>
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <span className={`truncate ${hasChildren ? "font-medium text-strong" : "text-secondary"}`}>{node.label}</span>
            {showChannelChip && node.row && <ChannelChip channel={node.row.channel} />}
          </div>
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

/** Top-level section band (Revenue, COGS, Bank & Cash, ...): collapsible header + its account rows + a "Total {label}" footer computed from the section's own rolled-up row. */
function SectionBlock({ node, ...rest }: RowCommonProps & { node: TreeNode }) {
  const { months, measure, isExpanded, toggle } = rest;
  const key = nodeKey(node, "root");
  const expanded = isExpanded(key);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <tr className="border-t border-line-strong/60 bg-surface/60">
        <td colSpan={months.length + 2} className="py-0">
          <button
            type="button"
            onClick={() => toggle(key)}
            disabled={!hasChildren}
            className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-surface-mid/40 transition-colors disabled:cursor-default"
          >
            <span className="text-muted text-xs w-3">{hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
            <span className="text-xs font-semibold text-secondary uppercase tracking-wide">{node.label}</span>
            {!hasChildren && <span className="text-xs text-faint italic">no mapped transactions</span>}
          </button>
        </td>
      </tr>

      {expanded && node.children.map((child, i) => (
        <AccountRow key={nodeKey(child, key) + i} node={child} path={key} {...rest} />
      ))}

      <tr className="border-t border-line-strong/60 bg-surface/40">
        <td className="py-1.5 px-4 text-xs text-secondary font-medium">Total {node.label}</td>
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
      <td className="py-2 px-4 text-xs font-semibold text-primary">{node.label}</td>
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

function TableHead({ months }: { months: string[] }) {
  return (
    <thead>
      <tr className="bg-surface border-b border-line sticky top-0 z-10">
        <th className="py-2 px-4 text-left text-xs text-muted uppercase tracking-wide font-semibold w-64">Account</th>
        {months.map((m) => (
          <th key={m} className="py-2 px-2 text-right text-xs text-muted uppercase tracking-wide font-medium w-24">
            {monthLabel(m)}
          </th>
        ))}
        <th className="py-2 pl-2 pr-4 text-right text-xs text-secondary uppercase tracking-wide font-semibold w-28">Total</th>
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
}

export default function FinancialsTable({ tree, months, measure, onToggleExpand, expandedKeys }: FinancialsTableProps) {
  // Uncontrolled fallback: track collapsed keys locally (default = everything
  // expanded) when the caller doesn't pass expandedKeys/onToggleExpand.
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(new Set());

  const isExpanded = useCallback(
    (key: string) => (expandedKeys ? expandedKeys.has(key) : !localCollapsed.has(key)),
    [expandedKeys, localCollapsed],
  );

  const toggle = useCallback(
    (key: string) => {
      if (onToggleExpand) {
        onToggleExpand(key);
        return;
      }
      setLocalCollapsed((prev) => {
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
        <TableHead months={months} />
        <tbody>
          {tree.map((node, i) => {
            const rowProps = { months, measure, isExpanded, toggle };
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
