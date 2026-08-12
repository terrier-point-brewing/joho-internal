"use client";

// Finance > Transactions > Manual Entries — the auditable UI for the
// manual_entries table (lib/finance/manualEntries.ts, app/api/finance/
// manual-entries/route.ts). Replaces app/taproom/components/ManualEntriesTab.tsx
// (retired in Task 5).
//
// Two kinds, stored as "flow" and "balance" and shown as "Transaction" and
// "Balance". A TRANSACTION is a movement over a date range: it prorates by day
// overlap and ADDS to its account, counting beside the invoices, expenses and
// bank lines that arrived from a feed -- on the P&L and, since transaction
// postings began reading them, on the Balance Sheet too. A BALANCE states an
// account's total at a month end and is the whole answer for an account on the
// Manual entry method; nothing else counts towards it.
//
// The stored values did not change with the labels: "flow" is a DB CHECK
// constraint value with several readers, and renaming it would be a migration
// for no gain a person can see. The month-end
// close checklist that used to sit on top of this ledger now lives at its own
// address, Finance > Period Close -- this page is purely the ledger.

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities";
import { queryKeys } from "@/lib/query-keys";
import { formatBalanceCents, formatCurrencyCents } from "@/lib/format";
import {
  monthEnd,
  type ManualEntryKind,
  type ManualEntryRecord,
  type ManualEntryInput,
} from "@/lib/finance/manualEntries";
import { buildManualEntryPatch } from "@/lib/finance/manualEntryPatch";
import { manualEntryEffect } from "@/lib/finance/manualEntryEffect";
import type { BalanceSourcesResponse } from "@/app/settings/finance/balance-sheet-accounts/types";
import {
  formatAmountInput,
  parseAmountInputCents,
  daysInclusive,
  perDayCents,
} from "@/lib/finance/manualEntryAmount";
import { ACCOUNT_TYPE_SECTION } from "@/lib/finance/accountSections";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import ToggleChip from "@/app/components/ui/ToggleChip";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import FilterBar from "@/app/components/ui/FilterBar";
import FilterSelect from "@/app/components/ui/FilterSelect";
import YearSelect from "../components/YearSelect";
import GlAccountFilter from "../components/GlAccountFilter";
import SummaryStatBar from "../components/SummaryStatBar";
import { LedgerTable, Th } from "../components/LedgerTable";
import AccountSelect, { type CoARef } from "../../AccountSelect";

// ── Helpers ───────────────────────────────────────────────────────────────────

const KIND_OPTIONS = [
  // The stored values stay "flow"/"balance" -- they are a DB CHECK constraint
  // and appear in several readers. Only what a person READS changed, because
  // "flow" named the implementation and "Flow (P&L)" became untrue the day
  // transaction postings started counting these on balance-sheet accounts too.
  { value: "flow", label: "Transactions" },
  { value: "balance", label: "Balances" },
];

/** account_type -> statement_section values that this codebase stores negative
 *  (credit-side of the ledger). Mirrors ACCOUNT_TYPE_SECTION's grouping. */
const CREDIT_SIDE_SECTIONS = new Set(["ap", "credit_card", "other_current_liabilities", "long_term_liabilities", "equity"]);

function isCreditSideAccount(accountType: string | undefined): boolean {
  if (!accountType) return false;
  const section = ACCOUNT_TYPE_SECTION[accountType];
  return !!section && CREDIT_SIDE_SECTIONS.has(section);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function accountLabel(account: CoARef | null): React.ReactNode {
  if (!account) return <span className="text-faint">—</span>;
  return (
    <>
      {account.account_number && <span className="text-muted font-mono mr-1.5">{account.account_number}</span>}
      {account.account_name}
    </>
  );
}

// ── Add / edit form ──────────────────────────────────────────────────────────

function ManualEntryFormModal({
  accounts,
  acceptedKindsByCoa,
  entry,
  onClose,
  onCreate,
  onUpdate,
}: {
  accounts: CoARef[];
  /**
   * Which entry kinds each account's calculation actually reads. An account
   * absent from the map has no active source, which the advice treats as its
   * own case rather than as "reads nothing".
   */
  acceptedKindsByCoa: Map<string, ManualEntryKind[]>;
  /** null = add mode */
  entry: ManualEntryRecord | null;
  onClose: () => void;
  onCreate: (input: ManualEntryInput) => Promise<void>;
  onUpdate: (existing: ManualEntryRecord, input: ManualEntryInput) => Promise<void>;
}) {
  const isEdit = entry != null;
  const todayStr = today();

  const [entryKind, setEntryKind] = useState<ManualEntryKind>(entry?.entryKind ?? "flow");
  const [chartOfAccountsId, setChartOfAccountsId] = useState<string | null>(entry?.chartOfAccountsId ?? null);
  const [startDate, setStartDate] = useState(entry?.startDate ?? todayStr);
  const [endDate, setEndDate] = useState(entry?.endDate ?? todayStr);
  const [asOfDate, setAsOfDate] = useState(entry?.asOfDate ?? monthEnd(todayStr));
  const [amountInput, setAmountInput] = useState(() =>
    entry ? formatAmountInput((entry.amountCents / 100).toFixed(2)) : "",
  );
  const [label, setLabel] = useState(entry?.label ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedAccount = accounts.find((a) => a.id === chartOfAccountsId) ?? null;
  const isCreditSide = isCreditSideAccount(selectedAccount?.account_type);
  const snappedAsOfDate = monthEnd(asOfDate || todayStr);
  // Advice is per kind AND per account, so it is recomputed as either changes.
  // Withheld entirely until an account is picked -- there is nothing truthful to
  // say about a kind on its own.
  const effect = chartOfAccountsId
    ? manualEntryEffect({ entryKind, accepted: acceptedKindsByCoa.get(chartOfAccountsId) ?? null })
    : { level: "ok" as const };

  function handleKindChange(next: ManualEntryKind) {
    setEntryKind(next);
    if (next === "balance") setAsOfDate((d) => monthEnd(d || todayStr));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!chartOfAccountsId) {
      setFormError("Select a GL account.");
      return;
    }
    const amountCents = parseAmountInputCents(amountInput);
    if (amountCents === null) {
      // Zero is a legitimate amount now (see manualEntries.ts's sign note), so
      // the only thing left to reject is an input with no number in it.
      setFormError(amountInput.trim() === "" ? "Enter an amount." : "That amount could not be read — type it like 1250.00.");
      return;
    }
    if (entryKind === "flow" && startDate > endDate) {
      setFormError("Start date must be on or before end date.");
      return;
    }

    // For a balance entry, ALWAYS submit the snapped month-end date — never
    // the raw picked date — so the saved row matches what the "Saves as"
    // preview below the input showed the user.
    const input: ManualEntryInput =
      entryKind === "flow"
        ? { entryKind, chartOfAccountsId, startDate, endDate, amountCents, label: label.trim() || null }
        : { entryKind, chartOfAccountsId, asOfDate: snappedAsOfDate, amountCents, label: label.trim() || null };

    setSubmitting(true);
    try {
      if (entry) await onUpdate(entry, input);
      else await onCreate(input);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit manual entry" : "Add manual entry"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Kind" required>
          <div className="flex items-center gap-1.5">
            <ToggleChip active={entryKind === "flow"} onClick={() => handleKindChange("flow")}>
              Transaction (adds to the account)
            </ToggleChip>
            <ToggleChip active={entryKind === "balance"} onClick={() => handleKindChange("balance")}>
              Balance (states the account&apos;s total)
            </ToggleChip>
          </div>
        </Field>

        <Field label="GL account" required>
          <AccountSelect
            value={chartOfAccountsId}
            onChange={setChartOfAccountsId}
            accounts={accounts}
            placeholder="Select an account…"
            className="w-full"
          />
          {/* Advice, not a block. The entry is still saveable: an operator may
              know something the configuration does not, and refusing the save
              would turn a wrong guess about their intent into lost work. */}
          {effect.level !== "ok" && (
            <p className={`text-2xs mt-1.5 leading-relaxed ${effect.level === "warn" ? "text-accent" : "text-faint"}`}>
              {effect.message}
            </p>
          )}
        </Field>

        {entryKind === "flow" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date" required>
              <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} className="inp" />
            </Field>
            <Field label="End date" required>
              <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className="inp" />
            </Field>
          </div>
        ) : (
          <Field label="As of date" required>
            <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="inp" />
            <p className={`text-2xs mt-1 ${snappedAsOfDate !== asOfDate ? "text-accent" : "text-faint"}`}>
              Saves as {fmtDate(snappedAsOfDate)} — balances only save on a month end.
            </p>
          </Field>
        )}

        <Field
          label="Amount"
          required
          hint={isCreditSide ? "liability/equity account — often stored negative" : "negatives accepted"}
        >
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">$</span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amountInput}
              onChange={(e) => setAmountInput(formatAmountInput(e.target.value))}
              className="inp pl-7 text-right font-mono"
            />
          </div>
        </Field>

        <Field label="Label" hint="optional">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Pre-Square historical data"
            className="inp"
          />
        </Field>

        {formError && <Banner>{formError}</Banner>}

        <ModalActions submitting={submitting} onCancel={onClose} label={isEdit ? "Save changes" : "Add entry"} />
      </form>
    </Modal>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function ManualEntryRow({
  entry,
  accounts,
  canManage,
  onEdit,
  onDelete,
}: {
  entry: ManualEntryRecord;
  accounts: CoARef[];
  canManage: boolean;
  onEdit: (entry: ManualEntryRecord) => void;
  onDelete: (entry: ManualEntryRecord) => void;
}) {
  const account = accounts.find((a) => a.id === entry.chartOfAccountsId) ?? null;
  const isFlow = entry.entryKind === "flow";
  const days = isFlow && entry.startDate && entry.endDate ? daysInclusive(entry.startDate, entry.endDate) : null;

  return (
    <tr className="border-t border-line/40 hover:bg-surface-mid/20">
      <td className="px-4 py-2">
        <Badge tone={isFlow ? "info" : "accent"}>{isFlow ? "Transaction" : "Balance"}</Badge>
      </td>
      <td className="px-4 py-2 text-body">{accountLabel(account)}</td>
      <td className="px-4 py-2 text-secondary whitespace-nowrap">
        {isFlow ? (
          <>
            {fmtDate(entry.startDate)}
            {entry.startDate !== entry.endDate && <> – {fmtDate(entry.endDate)}</>}
          </>
        ) : (
          fmtDate(entry.asOfDate)
        )}
      </td>
      {/* Every row in this table is a figure a person typed, so a stored zero
          must not render as the em-dash sentinel the shared money formatter
          uses for "nothing here" -- that is what made a legitimately empty
          cash tin indistinguishable on screen from an account nobody had
          touched. Both kinds, not just balances: a zero transaction is a deliberate
          correction and reads the same way. */}
      <td className="px-4 py-2 text-right font-mono tabular-nums text-strong">{formatBalanceCents(entry.amountCents)}</td>
      <td className="px-4 py-2 text-right font-mono text-muted">
        {isFlow && days ? formatCurrencyCents(perDayCents(entry.amountCents, days)) : <span className="text-disabled">—</span>}
      </td>
      <td className="px-4 py-2 text-muted text-xs max-w-[220px] truncate" title={entry.label ?? undefined}>
        {entry.label ?? <span className="text-disabled">—</span>}
      </td>
      <td className="px-4 py-2 text-2xs text-faint whitespace-nowrap">
        <div>{fmtDateTime(entry.updatedAt)}</div>
        {entry.updatedBy && <div className="text-disabled truncate max-w-[120px]" title={entry.updatedBy}>{entry.updatedBy}</div>}
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap">
        {canManage && (
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="btn-secondary btn-xxs" onClick={() => onEdit(entry)}>Edit</button>
            <button type="button" className="btn-danger btn-xxs" onClick={() => onDelete(entry)}>Delete</button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => ({}) as { error?: string });
  throw new Error(body.error ?? "Save failed — please try again.");
}

export default function ManualEntriesPage() {
  const { can } = usePermissions();
  const canManage = can(CAP.financeTransactionsManage);
  const qc = useQueryClient();

  // Alert emails sent before Period Close existed deep-link here with
  // `?periodEnd=`, expecting the old on-page checklist. That checklist now
  // lives at /finance/period-close/<period>, so honour the old link by
  // bouncing it there client-side rather than leaving it dead. Anything that
  // isn't a real month end is left alone -- there is nothing to redirect to.
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const requested = searchParams.get("periodEnd");
    if (requested && requested === monthEnd(requested)) {
      router.replace(`/finance/period-close/${requested}`);
    }
  }, [searchParams, router]);

  const [kindFilter, setKindFilter] = useState<ManualEntryKind | null>(null);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [glFilter, setGlFilter] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: "add" } | { mode: "edit"; entry: ManualEntryRecord } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManualEntryRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: entries = [], isLoading, error: loadError } = useQuery({
    queryKey: queryKeys.finance.manualEntries(kindFilter ?? "all", year),
    queryFn: () =>
      fetchJson<ManualEntryRecord[]>(`/api/finance/manual-entries?year=${year}${kindFilter ? `&kind=${kindFilter}` : ""}`),
  });

  const { data: accounts = [] } = useQuery({
    queryKey: queryKeys.finance.chartOfAccounts(),
    queryFn: () => fetchJson<CoARef[]>("/api/finance/chart-of-accounts"),
  });

  /**
   * Which entry kinds each account's calculation actually reads, so the form can
   * warn before an entry is saved against an account that will ignore it.
   *
   * The catalog endpoint, not the /live one: this needs the DECLARATIONS, which
   * are cheap, and never the computed figures, which are not. A failure here
   * leaves the map empty and the form simply says nothing -- advice is worth
   * having and is not worth blocking the screen for.
   */
  const { data: balanceSources } = useQuery({
    queryKey: queryKeys.finance.balanceSources(),
    queryFn: () => fetchJson<BalanceSourcesResponse>("/api/finance/balance-sources"),
    staleTime: 5 * 60 * 1000,
  });

  const acceptedKindsByCoa = useMemo(() => {
    const out = new Map<string, ManualEntryKind[]>();
    if (!balanceSources) return out;
    const kindsByMethod = new Map(balanceSources.methods.map((m) => [m.key, m.manualEntryKinds]));
    for (const account of balanceSources.accounts) {
      // Only ACTIVE sources speak for an account. A deactivated one is not what
      // the balance sheet reads, so letting it answer here would advise against
      // the kind that actually works.
      const active = account.sources.filter((s) => s.active);
      if (active.length === 0) continue;
      const kinds = new Set(active.flatMap((s) => kindsByMethod.get(s.methodKey) ?? []));
      out.set(account.id, Array.from(kinds));
    }
    return out;
  }, [balanceSources]);

  const visibleEntries = useMemo(
    () => (glFilter ? entries.filter((e) => e.chartOfAccountsId === glFilter) : entries),
    [entries, glFilter],
  );

  function invalidateEntries() {
    return qc.invalidateQueries({ queryKey: ["finance", "manual-entries"] });
  }

  async function handleCreate(input: ManualEntryInput) {
    const res = await fetch("/api/finance/manual-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    await throwOnError(res);
    await invalidateEntries();
  }

  async function handleUpdate(existing: ManualEntryRecord, input: ManualEntryInput) {
    const patch = buildManualEntryPatch(existing, input);
    const res = await fetch("/api/finance/manual-entries", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await throwOnError(res);
    await invalidateEntries();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setActionError(null);
    const res = await fetch("/api/finance/manual-entries", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deleteTarget.id }),
    });
    setDeleting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      setActionError(body.error ?? "Delete failed — please try again.");
      return;
    }
    setDeleteTarget(null);
    await invalidateEntries();
  }

  const flowCount = visibleEntries.filter((e) => e.entryKind === "flow").length;
  const balanceCount = visibleEntries.filter((e) => e.entryKind === "balance").length;
  const netTotal = visibleEntries.reduce((sum, e) => sum + e.amountCents, 0);

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 py-2">
        <FilterBar>
          <FilterSelect
            label="Kind"
            options={KIND_OPTIONS}
            value={kindFilter ? [kindFilter] : []}
            onChange={(v) => setKindFilter((v[0] as ManualEntryKind | undefined) ?? null)}
          />
          <YearSelect year={year} onChange={setYear} />
          <GlAccountFilter accounts={accounts} value={glFilter} onChange={setGlFilter} />
          {canManage && (
            <button type="button" className="btn-primary" onClick={() => setModal({ mode: "add" })}>
              + Add entry
            </button>
          )}
        </FilterBar>
      </div>

      {loadError && <Banner className="mx-4 sm:mx-6 my-2">{loadError instanceof Error ? loadError.message : "Failed to load manual entries."}</Banner>}
      {actionError && <Banner className="mx-4 sm:mx-6 my-2">{actionError}</Banner>}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : visibleEntries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No manual entries for {year}.</p>
            {canManage && <p className="text-xs text-faint mt-1">Click &ldquo;+ Add entry&rdquo; to record one.</p>}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col px-4 sm:px-6 py-4">
          <LedgerTable
            fill
            head={
              <>
                <Th label="Kind" />
                <Th label="Account" />
                <Th label="Date" />
                <Th label="Amount" align="right" />
                <Th label="Per Day" align="right" />
                <Th label="Label" />
                <Th label="Last updated" />
                <Th />
              </>
            }
          >
            {visibleEntries.map((entry) => (
              <ManualEntryRow
                key={entry.id}
                entry={entry}
                accounts={accounts}
                canManage={canManage}
                onEdit={(e) => setModal({ mode: "edit", entry: e })}
                onDelete={(e) => setDeleteTarget(e)}
              />
            ))}
          </LedgerTable>
          <p className="py-3 text-2xs text-faint">
            A transaction spreads across the days it covers and adds to its account, counting beside the
            invoices, expenses and bank lines that arrived on their own. A balance states an account&apos;s
            total at a month end, and is the whole answer for an account set to Manual entry.
          </p>
        </div>
      )}

      {visibleEntries.length > 0 && (
        <SummaryStatBar
          stats={[
            { label: "Entries", value: visibleEntries.length },
            { label: "Transactions", value: flowCount },
            { label: "Balances", value: balanceCount },
            { label: "Net total", value: formatCurrencyCents(netTotal), tone: netTotal < 0 ? "accent" : "strong" },
          ]}
        />
      )}

      {modal && (
        <ManualEntryFormModal
          accounts={accounts}
          acceptedKindsByCoa={acceptedKindsByCoa}
          entry={modal.mode === "edit" ? modal.entry : null}
          onClose={() => setModal(null)}
          onCreate={handleCreate}
          onUpdate={handleUpdate}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete manual entry"
          confirmLabel="Delete"
          tone="danger"
          busy={deleting}
          message={
            <>
              <p>
                Delete this {deleteTarget.entryKind === "flow" ? "transaction" : "balance"} entry
                {deleteTarget.label ? ` (“${deleteTarget.label}”)` : ""}?
                {deleteTarget.entryKind === "flow"
                  ? " This removes it from the P&L immediately."
                  : " Balance entries are not yet read by any statement."}
              </p>
              {/* The page-level <Banner> for actionError renders behind this
                  dialog's fixed backdrop, so a failed delete would leave the
                  user staring at an unchanged dialog. Surface it in here. */}
              {actionError && <Banner className="mt-3">{actionError}</Banner>}
            </>
          }
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
