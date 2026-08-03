"use client";
// Balance Sheet Accounts: the ONE screen where a balance-sheet account is
// configured, end to end.
//
// ── The workflow, and why it is all here ─────────────────────────────────────
// An operator thinks in three steps: pick an account, decide how it should be
// worked out, then finish whatever that choice needs. Those three used to be
// spread across four screens -- this one plus "Ramp Connection", "Square
// Connection" and "Bank Connections" -- and had to be done in the reverse of
// the order anyone would think of them, because a connection had to exist
// before this screen would offer it. The picker here even said "set one up
// first" without saying where. Those three screens are gone; step three now
// happens in a panel opened from the row it belongs to.
//
// ── It is generic on purpose ─────────────────────────────────────────────────
// Nothing in this file knows about Ramp, Plaid or Square. A method declares
// what it still needs (lib/finance/balances/methods/registry.ts's SetupField)
// and the panel renders it. A future calculation needing a rate and a date --
// no external service at all -- gets the same three-step experience with no
// change here.
//
// ── Rules only. Dollar values live in Transactions ───────────────────────────
// Still true, with one deliberate exception: an `operatorBalance` setup field
// writes a manual_entries balance row, the same row Finance > Transactions >
// Manual Entries writes. It is a shortcut to that store shown where it makes
// sense, never a second copy of it.
//
// ── The two balances are different questions ─────────────────────────────────
// "Last closed month" is the frozen snapshot. "Right now" is live-computed on
// every load from the same code the balance sheet statement uses. They used to
// be one column labelled "Current Balance" showing the snapshot, while the
// statement showed the live figure -- the same account reading two ways on two
// screens with nothing saying which was which.
//
// Gated on CAP.financeTransactionsManage via app/settings/finance/layout.tsx.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { EM_DASH, formatBalanceCents } from "@/lib/format";
import SettingsHeader from "@/app/settings/SettingsHeader";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import ToggleChip from "@/app/components/ui/ToggleChip";
import { Modal } from "@/app/components/ui/Modal";
import MethodSetupPanel from "./MethodSetupPanel";
import type {
  AccountRow,
  BalanceSourcesResponse,
  LiveBalancesResponse,
  MethodKind,
  MethodMeta,
  ReconciliationRow,
  SourceEntry,
} from "./types";

const MANUAL_ENTRIES_HREF = "/finance/transactions/manual-entries";

const KIND_LABEL: Record<MethodKind, string> = {
  manual: "Manual entry",
  postings: "Transaction postings",
  calculation: "Calculation",
};

const DIRECTION_PREFIX: Record<"add" | "subtract" | "net", string> = {
  add: "+",
  subtract: "−",
  net: "±",
};

async function putSource(
  coaId: string,
  providerKey: string,
  patch: { active?: boolean; config?: Record<string, unknown> } = {},
) {
  const res = await fetch("/api/finance/balance-sources", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ coaId, providerKey, ...patch }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not save that source.");
}

async function deleteSource(coaId: string, providerKey: string) {
  const res = await fetch("/api/finance/balance-sources", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ coaId, providerKey }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not remove that source.");
}

/** Account name with GL number prefix, matching every other finance table's convention. */
function accountLabel(a: AccountRow): string {
  return a.accountNumber ? `${a.accountNumber} · ${a.accountName}` : a.accountName;
}

/**
 * Re-orders the flat, GL-number-sorted account list into parent-then-children
 * order with a depth per row, so the table can indent sub-accounts under their
 * parent -- same "root = no parent, or parent outside this set" rule
 * chart-of-accounts/page.tsx's renderAccountTree uses, flattened instead of
 * recursive since this table is one flat tbody rather than section blocks.
 * Iterating the already-sorted array preserves each sibling bucket's relative
 * GL-number order, so no extra sort is needed.
 */
function orderHierarchically(accounts: AccountRow[]): { account: AccountRow; depth: number }[] {
  const ids = new Set(accounts.map((a) => a.id));
  const childrenOf = new Map<string, AccountRow[]>();
  const roots: AccountRow[] = [];
  for (const a of accounts) {
    if (a.parentId && ids.has(a.parentId)) {
      const bucket = childrenOf.get(a.parentId);
      if (bucket) bucket.push(a);
      else childrenOf.set(a.parentId, [a]);
    } else {
      roots.push(a);
    }
  }
  const out: { account: AccountRow; depth: number }[] = [];
  function walk(list: AccountRow[], depth: number) {
    for (const a of list) {
      out.push({ account: a, depth });
      const kids = childrenOf.get(a.id);
      if (kids) walk(kids, depth + 1);
    }
  }
  walk(roots, 0);
  return out;
}

/** Ids of accounts that have at least one child in this set -- the only accounts for which "excluded" (calculated by summing sub-accounts) makes sense. */
function accountsWithChildren(accounts: AccountRow[]): Set<string> {
  const ids = new Set(accounts.map((a) => a.id));
  const withChildren = new Set<string>();
  for (const a of accounts) {
    if (a.parentId && ids.has(a.parentId)) withChildren.add(a.parentId);
  }
  return withChildren;
}

async function patchExcluded(coaId: string, excluded: boolean) {
  const res = await fetch("/api/finance/chart-of-accounts", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: coaId, excluded }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not update that account.");
}

/**
 * One month's difference, in a sentence.
 *
 * Null and zero are worlds apart here and are never allowed to look alike. Null
 * means the bank account the money moves to had no records for the month, so
 * nothing was checked; zero means it was checked and nothing matched. Rendering
 * the first as "$0.00 accounted for" would be a confident answer built on no
 * evidence, which is the one failure this whole log exists to prevent.
 */
function explainReconciliation(row: ReconciliationRow): string {
  if (row.unexplainedCents === null || row.sweptExactCents === null || row.sweptNameOnlyCents === null) {
    return "There are no bank records for this month yet, so none of this difference has been accounted for.";
  }

  const matched = row.sweptExactCents + row.sweptNameOnlyCents;
  const head =
    row.unexplainedCents === 0
      ? `Your bank records account for all of it — ${formatBalanceCents(matched)} transferred out over ${row.sweptMatchCount ?? 0} payments.`
      : `Your bank records account for ${formatBalanceCents(matched)} of it, leaving ${formatBalanceCents(Math.abs(row.unexplainedCents))} unaccounted for.`;

  // Surfaced rather than folded in. A payment recognised only by the sender's
  // name is weaker evidence than one carrying their bank identifier, and a
  // reader deciding whether to trust the figure needs to know how much of it
  // rests on the weaker rule.
  return row.sweptNameOnlyCents > 0
    ? `${head} ${formatBalanceCents(row.sweptNameOnlyCents)} of that was recognised by the sender's name alone.`
    : head;
}

/**
 * "How is this calculated?" -- the method's declared steps, shown against this
 * account's real figures where they exist so the arithmetic is checkable rather
 * than abstract.
 *
 * Step LABELS, never step keys. The figures column on the main table used to
 * print the raw key ("squarePayoutsSinceAnchor: $4,268.28"), which is a code
 * identifier in the one place a bookkeeper is meant to be able to read a
 * balance.
 */
function MethodExplainer({
  method,
  account,
  onClose,
}: {
  method: MethodMeta;
  account: AccountRow | null;
  onClose: () => void;
}) {
  const figure = account?.liveBalance ?? account?.currentBalance ?? null;
  const contributions = figure?.contributions ?? {};
  const hasFigures = Object.keys(contributions).length > 0;

  return (
    <Modal title={method.label} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          {account && <p className="text-2xs text-faint mb-1">{accountLabel(account)}</p>}
          <p className="text-sm text-secondary">{method.summary}</p>
        </div>

        <div className="flex flex-col gap-3">
          {method.steps.map((step, i) => (
            <div key={step.key} className="flex items-start gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-surface-mid text-2xs text-muted flex items-center justify-center">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-body">{step.label}</p>
                <p className="text-2xs text-faint mt-0.5 leading-relaxed">{step.description}</p>
                <p className="text-2xs text-muted mt-0.5">Source: {step.source}</p>
              </div>
              {hasFigures && (
                <span className="shrink-0 font-mono text-xs tabular-nums text-body">
                  {/* A step absent from `contributions` did not run — the em dash is
                      that, and only that. A step that ran and contributed nothing
                      reads "+ $0.00", which is a different statement about the month. */}
                  {contributions[step.key] === undefined
                    ? EM_DASH
                    : `${DIRECTION_PREFIX[step.direction]} ${formatBalanceCents(Math.abs(contributions[step.key]))}`}
                </span>
              )}
            </div>
          ))}
        </div>

        {hasFigures && (
          <div className="flex items-center justify-between border-t border-line pt-3">
            <span className="text-xs text-body">
              {account?.liveBalance ? "Balance right now" : `Balance at ${account?.currentBalance?.periodEnd}`}
            </span>
            <span className="font-mono text-sm tabular-nums text-strong">{formatBalanceCents(figure!.cents)}</span>
          </div>
        )}

        {/* Shown whenever the account HAS month-end checks, not for a named
            method. An account whose balance is reported by the service it lives
            at has none and never will; one that is worked out from an entered
            figure accumulates one per month end. */}
        {(account?.reconciliations.length ?? 0) > 0 && (
          <div className="border-t border-line pt-3 flex flex-col gap-2">
            <div>
              <p className="text-xs text-body">How each month end turned out</p>
              <p className="text-2xs text-faint mt-0.5 leading-relaxed">
                Each month end the balance someone reads off the service replaces the worked-out one. This is the
                difference between the two, and how much of it the records from your bank account for.
              </p>
            </div>
            {account!.reconciliations.map((row) => (
              <div key={row.periodEnd} className="flex flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-2xs text-muted">{row.periodEnd}</span>
                  <span className="font-mono text-2xs tabular-nums text-body">
                    {formatBalanceCents(row.driftCents)}
                  </span>
                </div>
                <p className="text-2xs text-faint leading-relaxed">{explainReconciliation(row)}</p>
              </div>
            ))}
          </div>
        )}

        {method.steps.length > 1 && (
          <Card padding="p-3">
            <p className="text-2xs text-faint leading-relaxed">
              These steps always run together and cannot be enabled separately. Running only the first would report
              what has built up without ever subtracting what has been settled.
            </p>
          </Card>
        )}

        {!hasFigures && (
          <p className="text-2xs text-faint">
            No figures for this account yet, so there is nothing to show against the steps.
          </p>
        )}
      </div>
    </Modal>
  );
}

/** One configured method on an account, with its state and its actions. */
function SourceRow({
  account,
  source,
  method,
  saving,
  onExplain,
  onSetUp,
  onToggle,
  onRemove,
}: {
  account: AccountRow;
  source: SourceEntry;
  method: MethodMeta | undefined;
  saving: boolean;
  onExplain: () => void;
  onSetUp: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const needsSetup = (method?.setup.length ?? 0) > 0;
  const ready = source.setup?.ready ?? true;

  // Three states, not two. "Off" is a deliberate choice; "Needs setup" is
  // unfinished work; "Calculating" is done. Collapsing the last two is what let
  // an account with an active source produce nothing while looking configured.
  // "info", not "danger": an unfinished setup is work outstanding, not a fault.
  const tone = !source.active ? "neutral" : ready ? "success" : "info";
  const label = !source.active ? "Off" : ready ? "Calculating" : "Needs setup";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-body">{method?.label ?? source.methodKey}</span>
        <Badge tone={tone}>{label}</Badge>

        {needsSetup && (
          <button type="button" onClick={onSetUp} className={ready ? "btn-secondary btn-xxs" : "btn-primary btn-xxs"}>
            {ready ? "Settings" : "Finish setup"}
          </button>
        )}
        {method && (
          <button type="button" onClick={onExplain} className="btn-secondary btn-xxs">
            How is this calculated?
          </button>
        )}
        <button type="button" onClick={onToggle} disabled={saving} className="btn-secondary btn-xxs">
          {source.active ? "Disable" : "Enable"}
        </button>
        <button type="button" onClick={onRemove} disabled={saving} className="btn-danger btn-xxs">
          Remove
        </button>
        {source.methodKey === "manualBalance" && (
          <a href={MANUAL_ENTRIES_HREF} className="btn-secondary btn-xxs">
            All manual entries →
          </a>
        )}
        {saving && <span className="text-2xs text-faint animate-pulse">saving…</span>}
      </div>

      {/* One sentence naming the next thing to do, on the row itself, so the
          panel does not have to be opened to find out whether it is needed. */}
      {source.active && !ready && source.setup?.outstanding && (
        <span className="text-2xs text-info">{source.setup.outstanding}</span>
      )}
      {source.active && ready && source.connection?.lastSyncedAt && (
        <span className="text-2xs text-faint">
          {source.connection.label} · read {source.connection.lastSyncedAt.slice(0, 10)}
        </span>
      )}
      {account.liveError && source.active && <span className="text-2xs text-danger">{account.liveError}</span>}
    </div>
  );
}

export default function BalanceSheetAccountsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [pendingKind, setPendingKind] = useState<Record<string, MethodKind | "">>({});
  const [pendingMethod, setPendingMethod] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState<{ methodKey: string; accountId: string | null } | null>(null);
  const [settingUp, setSettingUp] = useState<{ accountId: string; methodKey: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.finance.balanceSources(),
    queryFn: () => fetchJson<BalanceSourcesResponse>("/api/finance/balance-sources"),
  });
  // Split from `data` because it is the expensive half -- see this query key's
  // own comment. Fetched in parallel with `data` on first load, but never
  // blocks a save: `refresh()` below only waits on the settings query.
  const { data: liveData } = useQuery({
    queryKey: queryKeys.finance.balanceSourcesLive(),
    queryFn: () => fetchJson<LiveBalancesResponse>("/api/finance/balance-sources/live"),
  });

  const methods = data?.methods ?? [];
  // Merged here, not sent as one payload -- a save only ever needs `data` to
  // reflect what changed, so liveBalance/liveError catch up on their own
  // schedule instead of making every save wait for them.
  const accounts: AccountRow[] = (data?.accounts ?? []).map((a) => ({
    ...a,
    liveBalance: liveData?.balances[a.id] ?? null,
    liveError: liveData?.failedAccounts.includes(a.id)
      ? (liveData.errors.find((e) => e.includes(a.id)) ?? "This account's calculation failed.")
      : null,
  }));
  const methodOf = (key: string) => methods.find((m) => m.key === key);

  /**
   * Refreshes the settings a save just changed. Deliberately does NOT wait on
   * the live balances query -- that one hits Ramp and Square per account and
   * can take several seconds, which used to make every save on this screen
   * feel that slow even though the save itself was one row. It is still
   * invalidated here, just not awaited, so the "Right now" column and the
   * setup panel's proof-it-worked figure catch up in the background instead of
   * blocking the button that triggered them.
   */
  async function refresh() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.finance.balanceSourcesLive() });
    await queryClient.invalidateQueries({ queryKey: queryKeys.finance.balanceSources() });
  }

  /** Resolves what the two selects currently amount to, or null when incomplete. */
  function chosenMethodKey(account: AccountRow): string | null {
    const kind = pendingKind[account.id];
    if (!kind) return null;
    if (kind === "calculation") return pendingMethod[account.id] || null;
    // Manual and postings each have exactly one method, so the kind IS the choice.
    return methods.find((m) => m.kind === kind && account.availableMethodKeys.includes(m.key))?.key ?? null;
  }

  /**
   * Adding a method opens its setup immediately when it needs any.
   *
   * This is the whole point of the refactor: choosing a calculation and
   * finishing what it needs are one continuous act, not two screens and a
   * guess about which one to visit next.
   */
  async function handleAdd(account: AccountRow) {
    const methodKey = chosenMethodKey(account);
    if (!methodKey) return;
    setSavingKey(`${account.id}:${methodKey}`);
    setError(null);
    try {
      await putSource(account.id, methodKey);
      setPendingKind((p) => ({ ...p, [account.id]: "" }));
      setPendingMethod((p) => ({ ...p, [account.id]: "" }));
      await refresh();
      if ((methodOf(methodKey)?.setup.length ?? 0) > 0) {
        setSettingUp({ accountId: account.id, methodKey });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that source.");
    } finally {
      setSavingKey(null);
    }
  }

  async function mutateSource(account: AccountRow, source: SourceEntry, run: () => Promise<void>, failure: string) {
    setSavingKey(`${account.id}:${source.methodKey}`);
    setError(null);
    try {
      await run();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setSavingKey(null);
    }
  }

  /**
   * A grouping account's balance is already the sum of its sub-accounts on the
   * real Balance Sheet statement (buildTree.ts rolls that up automatically) --
   * excluding it here just stops this screen and the Financials data-quality
   * tile from nagging it to be sourced directly, same as GL Mapping's
   * `excluded` toggles.
   */
  async function handleSetExcluded(account: AccountRow, excluded: boolean) {
    setSavingKey(`${account.id}:excluded`);
    setError(null);
    try {
      await patchExcluded(account.id, excluded);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that account.");
    } finally {
      setSavingKey(null);
    }
  }

  /**
   * Recomputes and stores the last CLOSED month.
   *
   * The open month needs no button -- it is worked out fresh on every load of
   * this screen and of the balance sheet. What could not be done before was
   * making a finished month pick up a source configured after its snapshot ran,
   * which meant waiting until 09:00 the next day to find out whether the setup
   * had worked at all.
   */
  async function handleRecompute() {
    setRecomputing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/finance/balance-sources/recompute", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as {
        periodEnd?: string;
        written?: number;
        skipped?: number;
        errors?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Could not recompute.");
      await refresh();
      // Errors are reported alongside the count rather than instead of it:
      // some accounts having succeeded is the normal partial outcome.
      setNotice(
        `Recomputed ${json.periodEnd}: ${json.written ?? 0} accounts written, ${json.skipped ?? 0} with nothing to report.` +
          (json.errors?.length ? ` ${json.errors.length} failed — ${json.errors[0]}` : ""),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not recompute.");
    } finally {
      setRecomputing(false);
    }
  }

  // A grouping account marked excluded has deliberately opted out of being
  // sourced directly (its balance is the sum of its children instead), so it
  // drops out of the denominator rather than reading as a permanent gap --
  // same "needsMapping = total - excludedCount" shape GL Mapping's panels use.
  const excludedCount = accounts.filter((a) => a.excluded).length;
  const relevantAccounts = accounts.filter((a) => !a.excluded);

  // Counted off READINESS, not off "a row exists". The old header counted rows
  // and reported twelve configured accounts when two of them had no connection
  // and no way to get one.
  const calculating = relevantAccounts.filter((a) => a.sources.some((s) => s.active && (s.setup?.ready ?? true))).length;
  const unfinished = relevantAccounts.filter((a) =>
    a.sources.some((s) => s.active && s.setup && !s.setup.ready),
  ).length;

  const parentIds = accountsWithChildren(accounts);
  const orderedAccounts = orderHierarchically(accounts);

  const explainingMethod = explaining ? methodOf(explaining.methodKey) : undefined;
  const explainingAccount = explaining?.accountId
    ? (accounts.find((a) => a.id === explaining.accountId) ?? null)
    : null;

  const setupAccount = settingUp ? (accounts.find((a) => a.id === settingUp.accountId) ?? null) : null;
  const setupSource = setupAccount?.sources.find((s) => s.methodKey === settingUp?.methodKey) ?? null;
  const setupMethod = settingUp ? methodOf(settingUp.methodKey) : undefined;

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6">
        <SettingsHeader
          title="Balance Sheet Accounts"
          description="Pick how each account is worked out, then finish whatever that choice needs — all on this screen. Dollar values live in Finance → Transactions."
          actions={
            <button type="button" className="btn-secondary btn-xxs" disabled={recomputing} onClick={handleRecompute}>
              {recomputing ? "Recomputing…" : "Recompute last month"}
            </button>
          }
        >
          <p className="text-sm text-muted pb-2">
            {accounts.length > 0
              ? `${calculating} of ${relevantAccounts.length} balance-sheet accounts are calculating` +
                (unfinished > 0 ? ` · ${unfinished} chosen but not finished` : "") +
                (excludedCount > 0 ? ` · ${excludedCount} excluded` : "")
              : "Balance-sheet accounts appear here once the chart of accounts is mapped."}
          </p>
        </SettingsHeader>
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}
      {notice && <Banner tone="success" className="mx-4 sm:mx-6 my-2">{notice}</Banner>}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : accounts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No balance-sheet accounts yet.</p>
            <p className="text-xs text-faint mt-1">Map the chart of accounts first, under Chart of Accounts.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left text-muted font-medium">Account</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">How it is calculated</th>
                  <th className="px-4 py-2 text-right text-muted font-medium">Right now</th>
                  <th className="px-4 py-2 text-right text-muted font-medium">Last closed month</th>
                </tr>
              </thead>
              <tbody>
                {orderedAccounts.map(({ account, depth }) => {
                  const addable = account.availableMethodKeys.filter(
                    (key) => !account.sources.some((s) => s.methodKey === key),
                  );
                  const addableKinds: MethodKind[] = (["manual", "postings", "calculation"] as MethodKind[]).filter(
                    (kind) => addable.some((key) => methodOf(key)?.kind === kind),
                  );
                  const kind = pendingKind[account.id] ?? "";
                  const chosen = chosenMethodKey(account);
                  const canExclude = parentIds.has(account.id);

                  return (
                    <tr key={account.id} className="border-t border-line/40 align-top hover:bg-surface-mid/20">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap" style={depth > 0 ? { paddingLeft: `${depth * 1.25}rem` } : undefined}>
                          {depth > 0 && (
                            <span className="text-disabled shrink-0 font-mono text-2xs">{"·".repeat(depth)}└</span>
                          )}
                          <span className="text-body">{accountLabel(account)}</span>
                          {canExclude && (
                            <ToggleChip active={account.excluded} onClick={() => handleSetExcluded(account, !account.excluded)}>
                              {account.excluded ? "Excluded" : "Exclude"}
                            </ToggleChip>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        {account.excluded ? (
                          <span className="text-2xs text-faint" title="This account was marked excluded — its balance comes only from summing its sub-accounts">
                            Excluded — calculated by summing its sub-accounts
                          </span>
                        ) : (
                        <div className="flex flex-col gap-2">
                          {account.sources.length === 0 && (
                            <span className="text-2xs text-faint italic">No method configured</span>
                          )}
                          {account.sources.map((source) => (
                            <SourceRow
                              key={source.methodKey}
                              account={account}
                              source={source}
                              method={methodOf(source.methodKey)}
                              saving={savingKey === `${account.id}:${source.methodKey}`}
                              onExplain={() => setExplaining({ methodKey: source.methodKey, accountId: account.id })}
                              onSetUp={() => setSettingUp({ accountId: account.id, methodKey: source.methodKey })}
                              onToggle={() =>
                                mutateSource(
                                  account,
                                  source,
                                  () => putSource(account.id, source.methodKey, { active: !source.active }),
                                  "Could not update that source.",
                                )
                              }
                              onRemove={() =>
                                mutateSource(
                                  account,
                                  source,
                                  () => deleteSource(account.id, source.methodKey),
                                  "Could not remove that source.",
                                )
                              }
                            />
                          ))}

                          {addableKinds.length > 0 && (
                            <div className="flex items-center gap-2 flex-wrap">
                              <select
                                value={kind}
                                onChange={(e) => {
                                  setPendingKind((p) => ({ ...p, [account.id]: e.target.value as MethodKind | "" }));
                                  setPendingMethod((p) => ({ ...p, [account.id]: "" }));
                                }}
                                className="inp-sm w-auto"
                              >
                                <option value="">— add a method —</option>
                                {addableKinds.map((k) => (
                                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                                ))}
                              </select>

                              {kind === "calculation" && (
                                <select
                                  value={pendingMethod[account.id] ?? ""}
                                  onChange={(e) => setPendingMethod((p) => ({ ...p, [account.id]: e.target.value }))}
                                  className="inp-sm w-auto"
                                >
                                  <option value="">— which calculation —</option>
                                  {addable
                                    .filter((key) => methodOf(key)?.kind === "calculation")
                                    .map((key) => (
                                      <option key={key} value={key}>{methodOf(key)?.label ?? key}</option>
                                    ))}
                                </select>
                              )}

                              {chosen && (
                                <button
                                  type="button"
                                  onClick={() => setExplaining({ methodKey: chosen, accountId: account.id })}
                                  className="btn-secondary btn-xxs"
                                >
                                  Preview
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleAdd(account)}
                                disabled={!chosen}
                                className="btn-primary btn-xxs"
                              >
                                Add
                              </button>
                            </div>
                          )}
                        </div>
                        )}
                      </td>

                      {/* formatBalanceCents, never formatCurrencyCents: the em dash in
                          the else-branch is this screen's "no balance could be worked
                          out" and must stay the only thing that renders it. The
                          statement formatter blanks an exact zero, which would make a
                          checked-and-empty account read as an unsourced one — the
                          "null, not zero" rule failing at the display instead of in
                          the data. Same reasoning for every figure on this screen. */}
                      <td className="px-4 py-3 text-right">
                        {account.liveBalance ? (
                          <span className="font-mono text-sm tabular-nums text-strong">
                            {formatBalanceCents(account.liveBalance.cents)}
                          </span>
                        ) : (
                          <span className="text-2xs text-faint">{EM_DASH}</span>
                        )}
                      </td>

                      <td className="px-4 py-3 text-right">
                        {account.currentBalance ? (
                          <div className="flex flex-col gap-0.5 items-end">
                            <span className="font-mono text-sm tabular-nums text-body">
                              {formatBalanceCents(account.currentBalance.cents)}
                            </span>
                            <span className="text-2xs text-faint">{account.currentBalance.periodEnd}</span>
                          </div>
                        ) : (
                          <span className="text-2xs text-faint">No snapshot yet</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Card padding="p-3" className="mt-3">
            <p className="text-2xs text-faint">
              &ldquo;Right now&rdquo; is worked out fresh every time this page loads, for the month still in progress —
              it is never stored. &ldquo;Last closed month&rdquo; is the saved snapshot, and is what the balance sheet
              reports for a finished month. Neither can be edited here; to correct a manually-entered figure use{" "}
              <a href={MANUAL_ENTRIES_HREF} className="text-accent hover:text-accent-soft">Manual Entries</a>.
            </p>
          </Card>
        </div>
      )}

      {explaining && explainingMethod && (
        <MethodExplainer method={explainingMethod} account={explainingAccount} onClose={() => setExplaining(null)} />
      )}

      {settingUp && setupMethod && setupAccount && setupSource && (
        <MethodSetupPanel
          method={setupMethod}
          account={setupAccount}
          source={setupSource}
          allAccounts={accounts}
          users={data?.users ?? []}
          providers={data?.providers ?? {}}
          onRefresh={refresh}
          onClose={() => setSettingUp(null)}
        />
      )}
    </>
  );
}
