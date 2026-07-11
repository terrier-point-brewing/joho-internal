"use client";
// Shared machinery for the finance statement pages (P&L, Cash Flow, Balance Sheet).
// Extracted from three near-identical copies. Presentation/structure only — no data logic.

import { useState, useEffect, type ReactNode } from "react";
import { formatCurrencyCents, EM_DASH } from "@/lib/format";
import PageHeader from "@/app/components/PageHeader";

export const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── Money formatting ────────────────────────────────────────────────────────────
// Money display comes from the single source of truth in lib/format.ts:
// `formatCurrencyCents` renders accounting style (parentheses for negatives,
// em-dash for zero).

/** Colored money cell for the MoM tables. */
export function MoneyCell({ cents, dim }: { cents: number; dim?: boolean }) {
  if (cents === 0) return <span className="text-faint">{EM_DASH}</span>;
  const neg = cents < 0;
  return <span className={dim ? "text-muted" : neg ? "text-danger" : "text-strong"}>{formatCurrencyCents(cents)}</span>;
}

// Strip "Parent Name: " prefix from sub-account names (QuickBooks export format)
export function shortName(name: string, parentName: string | undefined): string {
  if (!parentName) return name;
  const prefix = parentName + ":";
  if (name.startsWith(prefix)) return name.slice(prefix.length).trim();
  const prefixSpace = parentName + " : ";
  if (name.startsWith(prefixSpace)) return name.slice(prefixSpace.length).trim();
  return name;
}

// ── Generic account tree ────────────────────────────────────────────────────────

export interface TreeNode<T> {
  acct: T;
  children: TreeNode<T>[];
}

/** Build a parent/child tree from a flat account list keyed by id/parent_id. */
export function buildTree<T extends { id: string; parent_id?: string | null }>(
  accounts: T[]
): TreeNode<T>[] {
  const byId = new Map<string, TreeNode<T>>();
  for (const acct of accounts) byId.set(acct.id, { acct, children: [] });
  const roots: TreeNode<T>[] = [];
  for (const node of byId.values()) {
    const pid = node.acct.parent_id;
    if (pid && byId.has(pid)) byId.get(pid)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// ── Month-over-month tree types & helpers (P&L / Cash Flow) ──────────────────────

export interface MoMAccount {
  id: string;
  parent_id?: string | null;
  account_name: string;
  account_number?: string | null;
  section: string;
  monthly: Record<string, { cents: number }>;
}

export function sumMonthly<T extends MoMAccount>(nodes: TreeNode<T>[], monthKey: string): number {
  let total = 0;
  for (const n of nodes) {
    total += n.acct.monthly[monthKey]?.cents ?? 0;
    total += sumMonthly(n.children, monthKey);
  }
  return total;
}

export function totalForNode<T extends MoMAccount>(node: TreeNode<T>, months: string[]): number {
  return months.reduce((s, m) => s + (node.acct.monthly[m]?.cents ?? 0), 0)
    + node.children.reduce((s, c) => s + totalForNode(c, months), 0);
}

// ── MoM row components ───────────────────────────────────────────────────────────

export function AccountRow<T extends MoMAccount>({
  node, months, depth, parentName, expandAll,
}: {
  node: TreeNode<T>;
  months: string[];
  depth: number;
  parentName?: string;
  expandAll: boolean | null; // null = uncontrolled
}) {
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (expandAll !== null) setExpanded(expandAll);
  }, [expandAll]);

  const displayName = shortName(node.acct.account_name, parentName);
  const rowTotal = totalForNode(node, months);
  const hasData = rowTotal !== 0 || months.some(m => (node.acct.monthly[m]?.cents ?? 0) !== 0);

  return (
    <>
      <tr className={`border-t border-line/40 hover:bg-surface/20 ${!hasData ? "opacity-40" : ""}`}>
        <td className="py-1.5 pr-3 text-xs whitespace-nowrap" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
          <div className="flex items-center gap-1.5 min-w-0">
            {hasChildren && (
              <button onClick={() => setExpanded(e => !e)} className="text-faint hover:text-secondary w-3 shrink-0 text-[10px]">
                {expanded ? "▾" : "▸"}
              </button>
            )}
            {!hasChildren && <span className="w-3 shrink-0" />}
            {node.acct.account_number && (
              <span className="text-faint font-mono text-[10px] shrink-0">{node.acct.account_number}</span>
            )}
            <span className={`truncate ${hasChildren ? "font-medium text-strong" : "text-secondary"}`}>
              {displayName}
            </span>
          </div>
        </td>
        {months.map(m => {
          const own = node.acct.monthly[m]?.cents ?? 0;
          const childSum = node.children.reduce((s, c) => s + totalForNode(c, [m]), 0);
          const effective = own + childSum;
          return (
            <td key={m} className="py-1.5 px-2 text-right font-mono tabular-nums text-xs">
              {hasChildren && !expanded
                ? <MoneyCell cents={effective} />
                : <MoneyCell cents={own} dim={hasChildren} />}
            </td>
          );
        })}
        <td className="py-1.5 pl-2 pr-4 text-right font-mono tabular-nums text-xs font-semibold">
          <MoneyCell cents={rowTotal} />
        </td>
      </tr>
      {expanded && node.children.map(child => (
        <AccountRow key={child.acct.id} node={child} months={months} depth={depth + 1}
          parentName={node.acct.account_name} expandAll={expandAll} />
      ))}
    </>
  );
}

export function SectionRows<T extends MoMAccount>({
  title, nodes, months, totalLabel, expandAll, pendingNote,
}: {
  title: string;
  nodes: TreeNode<T>[];
  months: string[];
  totalLabel: string;
  expandAll: boolean | null;
  pendingNote?: string;
}) {
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (expandAll !== null) setExpanded(expandAll);
  }, [expandAll]);

  const hasData = nodes.some(n => totalForNode(n, months) !== 0);
  const sectionTotals = months.map(m => sumMonthly(nodes, m));
  const grandTotal = sectionTotals.reduce((s, c) => s + c, 0);

  return (
    <>
      <tr className="border-t border-line-strong/60 bg-surface/60">
        <td colSpan={months.length + 2} className="py-0">
          <button onClick={() => setExpanded(e => !e)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-mid/40 transition-colors">
            <span className="text-muted text-[10px] w-3">{expanded ? "▾" : "▸"}</span>
            <span className="text-[10px] font-semibold text-secondary uppercase tracking-wider">{title}</span>
            {pendingNote
              ? <span className="text-[10px] text-faint italic">{pendingNote}</span>
              : !hasData && <span className="text-[10px] text-faint italic">no mapped transactions</span>}
          </button>
        </td>
      </tr>

      {expanded && nodes.map(node => (
        <AccountRow key={node.acct.id} node={node} months={months} depth={0}
          parentName={undefined} expandAll={expandAll} />
      ))}

      <tr className="border-t border-line-strong/60 bg-surface/40">
        <td className="py-1.5 px-4 text-xs text-secondary font-medium">{totalLabel}</td>
        {sectionTotals.map((cents, i) => (
          <td key={months[i]} className="py-1.5 px-2 text-right font-mono tabular-nums text-xs font-semibold text-strong">
            {formatCurrencyCents(cents)}
          </td>
        ))}
        <td className="py-1.5 pl-2 pr-4 text-right font-mono tabular-nums text-xs font-bold text-primary">
          {formatCurrencyCents(grandTotal)}
        </td>
      </tr>
    </>
  );
}

export function SubtotalRow({
  label, monthTotals, highlight,
}: {
  label: string;
  monthTotals: number[];
  highlight?: boolean;
}) {
  const grand = monthTotals.reduce((s, c) => s + c, 0);
  return (
    <tr className={`border-t-2 border-line-subtle ${highlight ? "bg-surface-mid/50" : "bg-surface/60"}`}>
      <td className={`py-2 px-4 text-xs font-bold ${highlight ? "text-primary" : "text-strong"}`}>{label}</td>
      {monthTotals.map((cents, i) => (
        <td key={i} className={`py-2 px-2 text-right font-mono tabular-nums text-xs font-bold ${cents < 0 ? "text-danger" : highlight ? "text-accent-soft" : "text-primary"}`}>
          {formatCurrencyCents(cents)}
        </td>
      ))}
      <td className={`py-2 pl-2 pr-4 text-right font-mono tabular-nums text-sm font-bold ${grand < 0 ? "text-danger" : highlight ? "text-accent-soft" : "text-primary"}`}>
        {formatCurrencyCents(grand)}
      </td>
    </tr>
  );
}

/** Sticky table header row for the MoM statements (Account + month columns + Total). */
export function MoMTableHead({ months }: { months: string[] }) {
  return (
    <thead>
      <tr className="bg-surface border-b border-line sticky top-0 z-10">
        <th className="py-2 px-4 text-left text-[10px] text-faint uppercase tracking-wider font-medium w-64">
          Account
        </th>
        {months.map((m, i) => (
          <th key={m} className="py-2 px-2 text-right text-[10px] text-muted uppercase tracking-wider font-medium w-24">
            {MONTH_NAMES[i]}
          </th>
        ))}
        <th className="py-2 pl-2 pr-4 text-right text-[10px] text-secondary uppercase tracking-wider font-semibold w-28">
          Total
        </th>
      </tr>
    </thead>
  );
}

/**
 * Shared statement page header: PageHeader (title + description) plus the Expand/Collapse
 * controls and a right-aligned controls slot (year/month selects). Used by all three
 * statement pages so the chrome is defined once.
 */
export function StatementHeader({
  title, description, onExpandAll, children,
}: {
  title: string;
  description: string;
  onExpandAll: (val: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="shrink-0 px-4 sm:px-6 flex items-center justify-between gap-4">
      <PageHeader title={title} description={description} />
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={() => onExpandAll(true)} className="btn-secondary">Expand All</button>
        <button onClick={() => onExpandAll(false)} className="btn-secondary">Collapse All</button>
        {children}
      </div>
    </div>
  );
}
