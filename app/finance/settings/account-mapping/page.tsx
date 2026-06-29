"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import FinanceNav from "../../FinanceNav";
import SettingsNav from "../SettingsNav";

interface CoAAccount {
  id: string;
  account_name: string;
  account_number: string | null;
  account_type: string;
}

interface VariationRow {
  id: string;
  square_variation_id: string;
  variation_name: string;
  sku: string | null;
  upc: string | null;
  price_amount: number | null;
  price_currency: string | null;
  pricing_type: string | null;
  chart_of_accounts_id: string | null;
  chart_of_accounts_id_pos: string | null;
  chart_of_accounts_id_invoice: string | null;
  bs_chart_of_accounts_id: string | null;
  pl_chart_of_accounts_id: string | null;
  chart_of_accounts: { account_name: string; account_number: string | null; account_type: string } | null;
  coa_pos: { account_name: string; account_number: string | null; account_type: string } | null;
  coa_invoice: { account_name: string; account_number: string | null; account_type: string } | null;
  coa_bs: { account_name: string; account_number: string | null; account_type: string } | null;
  coa_pl: { account_name: string; account_number: string | null; account_type: string } | null;
  square_catalog_items: {
    id: string;
    square_item_id: string;
    item_name: string;
    category_id: string | null;
    category_name: string | null;
    parent_category_id: string | null;
    parent_category_name: string | null;
    is_top_level_category: boolean | null;
    product_type: string | null;
    is_archived: boolean;
  } | null;
}

interface GroupedItem {
  square_item_id: string;
  item_name: string;
  is_archived: boolean;
  variations: VariationRow[];
}

interface GroupedSubcategory {
  category_id: string | null;
  category_name: string;
  items: GroupedItem[];
}

interface GroupedParent {
  parent_id: string | null;   // null = top-level with no children, or uncategorized
  parent_name: string;
  subcategories: GroupedSubcategory[];
}

function fmtPrice(amount: number | null, currency: string | null, pricingType: string | null) {
  if (pricingType === "VARIABLE_PRICING") return "Variable";
  if (amount === null) return "—";
  return (amount / 100).toLocaleString("en-US", { style: "currency", currency: currency ?? "USD" });
}

function accountLabel(a: { account_name: string; account_number: string | null }) {
  return a.account_number ? `${a.account_number} · ${a.account_name}` : a.account_name;
}

function shortAccountName(name: string) {
  const parts = name.split(":");
  return parts[parts.length - 1].trim();
}

function AccountSelect({
  value,
  onChange,
  accounts,
  placeholder = "— no mapping —",
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  accounts: CoAAccount[];
  placeholder?: string;
}) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef           = useRef<HTMLDivElement>(null);
  const inputRef          = useRef<HTMLInputElement>(null);

  const selected = accounts.find((a) => a.id === value) ?? null;

  const filtered = query.trim()
    ? accounts.filter((a) =>
        `${a.account_number ?? ""} ${a.account_name} ${a.account_type}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
    : accounts;

  // Group filtered results by account_type
  const grouped = filtered.reduce<Record<string, CoAAccount[]>>((acc, a) => {
    (acc[a.account_type] ??= []).push(a);
    return acc;
  }, {});
  const groupEntries = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function handleOpen() {
    setOpen(true);
    setQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleSelect(id: string | null) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={wrapRef} className="relative w-full max-w-[360px]">
      {/* Trigger */}
      <button
        type="button"
        onClick={handleOpen}
        className="w-full flex items-center justify-between gap-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-left focus:outline-none focus:border-amber-600 hover:border-zinc-500 transition-colors"
      >
        <span className={`truncate ${selected ? "text-zinc-200" : "text-zinc-500"}`} title={selected ? accountLabel(selected) : undefined}>
          {selected
            ? (selected.account_number
                ? `${selected.account_number} · ${shortAccountName(selected.account_name)}`
                : shortAccountName(selected.account_name))
            : placeholder}
        </span>
        <span className="text-zinc-600 shrink-0">⌄</span>
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl flex flex-col max-h-64">
          {/* Search input */}
          <div className="p-1.5 border-b border-zinc-800 shrink-0">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
              placeholder="Search accounts…"
              className="w-full bg-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none"
            />
          </div>

          {/* Options */}
          <div className="overflow-y-auto">
            {/* Clear option */}
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); handleSelect(null); }}
              className={`w-full text-left px-3 py-2 text-xs border-b border-zinc-800/50 transition-colors ${
                !value ? "text-amber-400 bg-amber-900/20" : "text-zinc-500 hover:bg-zinc-800"
              }`}
            >
              {placeholder}
            </button>

            {groupEntries.length === 0 && (
              <p className="px-3 py-3 text-xs text-zinc-600 italic text-center">No matches</p>
            )}

            {groupEntries.map(([type, accs]) => (
              <div key={type}>
                <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider bg-zinc-900/80 sticky top-0">
                  {type}
                </div>
                {accs
                  .sort((a, b) => (a.account_number ?? "").localeCompare(b.account_number ?? "") || a.account_name.localeCompare(b.account_name))
                  .map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); handleSelect(a.id); }}
                      className={`w-full text-left px-3 py-2 text-xs transition-colors border-t border-zinc-800/30 ${
                        a.id === value
                          ? "bg-amber-900/30 text-amber-300"
                          : "text-zinc-300 hover:bg-zinc-800"
                      }`}
                    >
                      {a.account_number && (
                        <span className="text-zinc-500 font-mono mr-1.5">{a.account_number}</span>
                      )}
                      {a.account_name}
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function VariationMappingRow({
  variation,
  accounts,
  onSave,
  onSaveSource,
  onSaveDeposit,
}: {
  variation: VariationRow;
  accounts: CoAAccount[];
  onSave: (squareVariationId: string, accountId: string | null) => Promise<void>;
  onSaveSource: (squareVariationId: string, field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice", accountId: string | null) => Promise<void>;
  onSaveDeposit: (squareVariationId: string, field: "bs_chart_of_accounts_id" | "pl_chart_of_accounts_id", accountId: string | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const hasSplit   = !!(variation.chart_of_accounts_id_pos || variation.chart_of_accounts_id_invoice);
  const hasDeposit = !!(variation.bs_chart_of_accounts_id || variation.pl_chart_of_accounts_id);
  const [splitOpen, setSplitOpen]     = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);

  async function handleChange(accountId: string | null) {
    setSaving(true);
    await onSave(variation.square_variation_id, accountId);
    setSaving(false);
  }

  async function handleSourceChange(field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice", accountId: string | null) {
    setSaving(true);
    await onSaveSource(variation.square_variation_id, field, accountId);
    setSaving(false);
  }

  async function handleDepositChange(field: "bs_chart_of_accounts_id" | "pl_chart_of_accounts_id", accountId: string | null) {
    setSaving(true);
    await onSaveDeposit(variation.square_variation_id, field, accountId);
    setSaving(false);
  }

  async function handleClearSplit() {
    setSaving(true);
    await onSaveSource(variation.square_variation_id, "chart_of_accounts_id_pos", null);
    await onSaveSource(variation.square_variation_id, "chart_of_accounts_id_invoice", null);
    setSaving(false);
    setSplitOpen(false);
  }

  async function handleClearDeposit() {
    setSaving(true);
    await onSaveDeposit(variation.square_variation_id, "bs_chart_of_accounts_id", null);
    await onSaveDeposit(variation.square_variation_id, "pl_chart_of_accounts_id", null);
    setSaving(false);
    setDepositOpen(false);
  }

  const price = fmtPrice(variation.price_amount, variation.price_currency, variation.pricing_type);

  return (
    <div className="border-t border-zinc-800/30">
      {/* Main row */}
      <div className="flex items-center gap-3 pl-6 pr-4 py-2.5 bg-zinc-950/40 hover:bg-zinc-900/30 transition-colors">
        {/* Left: variation name + price */}
        <div className="w-44 shrink-0 min-w-0">
          <div className="text-xs text-zinc-300 truncate">{variation.variation_name}</div>
          <div className="text-[10px] text-zinc-600 tabular-nums mt-0.5">{price}</div>
        </div>
        {/* Middle: default GL account */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {saving && <span className="text-[10px] text-zinc-600 shrink-0">Saving…</span>}
          <AccountSelect
            value={variation.chart_of_accounts_id}
            onChange={handleChange}
            accounts={accounts}
            placeholder="— no mapping —"
          />
        </div>
        {/* Right: toggles */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => { setSplitOpen((o) => !o); setDepositOpen(false); }}
            title={splitOpen ? "Hide POS/Invoice overrides" : "Split by POS / Invoice source"}
            className={`px-2 py-1.5 text-[10px] rounded border transition-colors ${
              hasSplit
                ? "bg-blue-900/40 border-blue-700 text-blue-300 hover:bg-blue-900/60"
                : "bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
            }`}
          >
            {splitOpen ? "▴ split" : "split ▾"}
          </button>
          <button
            type="button"
            onClick={() => { setDepositOpen((o) => !o); setSplitOpen(false); }}
            title={depositOpen ? "Hide deposit BS/PL mapping" : "Set deposit recognition accounts (BS → P&L)"}
            className={`px-2 py-1.5 text-[10px] rounded border transition-colors ${
              hasDeposit
                ? "bg-violet-900/40 border-violet-700 text-violet-300 hover:bg-violet-900/60"
                : "bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
            }`}
          >
            {depositOpen ? "▴ deposit" : "deposit ▾"}
          </button>
        </div>
      </div>

      {/* Source override rows (POS / Invoice) */}
      {splitOpen && (
        <div className="pl-6 pr-4 pb-3 pt-2 flex flex-col gap-2 bg-blue-950/10 border-t border-blue-900/20">
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-zinc-500 w-16 shrink-0 text-right">POS</span>
            <AccountSelect
              value={variation.chart_of_accounts_id_pos}
              onChange={(id) => handleSourceChange("chart_of_accounts_id_pos", id)}
              accounts={accounts}
              placeholder="— same as default —"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-zinc-500 w-16 shrink-0 text-right">Invoice</span>
            <AccountSelect
              value={variation.chart_of_accounts_id_invoice}
              onChange={(id) => handleSourceChange("chart_of_accounts_id_invoice", id)}
              accounts={accounts}
              placeholder="— same as default —"
            />
          </div>
          {hasSplit && (
            <button type="button" onClick={handleClearSplit} className="self-end text-[10px] text-zinc-600 hover:text-red-400 transition-colors">
              Clear overrides
            </button>
          )}
        </div>
      )}

      {/* Deposit recognition rows (BS / P&L) */}
      {depositOpen && (
        <div className="pl-6 pr-4 pb-3 pt-2 flex flex-col gap-2 bg-violet-950/10 border-t border-violet-900/20">
          <p className="text-[10px] text-zinc-500 leading-relaxed">
            When a line item has deposit accounts set, it records to <span className="text-violet-300">Balance Sheet</span> until the linked delivery invoice is paid, then moves to <span className="text-violet-300">P&amp;L</span>.
          </p>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-zinc-400 w-16 shrink-0 text-right">BS account</span>
            <AccountSelect
              value={variation.bs_chart_of_accounts_id}
              onChange={(id) => handleDepositChange("bs_chart_of_accounts_id", id)}
              accounts={accounts}
              placeholder="— none —"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-zinc-400 w-16 shrink-0 text-right">P&amp;L account</span>
            <AccountSelect
              value={variation.pl_chart_of_accounts_id}
              onChange={(id) => handleDepositChange("pl_chart_of_accounts_id", id)}
              accounts={accounts}
              placeholder="— none —"
            />
          </div>
          {hasDeposit && (
            <button type="button" onClick={handleClearDeposit} className="self-end text-[10px] text-zinc-600 hover:text-red-400 transition-colors">
              Clear deposit mapping
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BulkMapper({
  unmappedCount,
  accounts,
  onApply,
}: {
  unmappedCount: number;
  accounts: CoAAccount[];
  onApply: (accountId: string | null, overwrite: boolean) => Promise<void>;
}) {
  const [draft, setDraft]       = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  async function apply(ow: boolean) {
    if (!draft) return;
    setApplying(true);
    await onApply(draft, ow);
    setDraft(null);
    setApplying(false);
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <AccountSelect value={draft} onChange={setDraft} accounts={accounts} placeholder="Bulk map…" />
      {draft && (
        <>
          <button
            onClick={() => apply(false)}
            disabled={applying || unmappedCount === 0}
            title={`Fill ${unmappedCount} unmapped`}
            className="px-2 py-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-[10px] rounded transition-colors whitespace-nowrap">
            {applying ? "…" : `Fill ${unmappedCount}`}
          </button>
          <button
            onClick={() => apply(true)}
            disabled={applying}
            title="Overwrite all"
            className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-zinc-300 text-[10px] rounded transition-colors whitespace-nowrap">
            All
          </button>
        </>
      )}
    </div>
  );
}

function BulkSourceMapper({
  accounts,
  hasSplits,
  onApply,
}: {
  accounts: CoAAccount[];
  hasSplits: boolean;
  onApply: (field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice", accountId: string | null, overwrite: boolean) => Promise<void>;
}) {
  const [open, setOpen]         = useState(false);
  const [draftPos, setDraftPos] = useState<string | null>(null);
  const [draftInv, setDraftInv] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  async function apply(field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice", draft: string | null, ow: boolean) {
    if (!draft) return;
    setApplying(true);
    await onApply(field, draft, ow);
    setApplying(false);
  }

  return (
    <>
      {/* Toggle button */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`shrink-0 px-1.5 py-1 text-[10px] rounded border transition-colors ${
          open
            ? "bg-blue-900/60 border-blue-600 text-blue-200"
            : hasSplits
            ? "bg-blue-900/40 border-blue-700 text-blue-300 hover:bg-blue-900/60"
            : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
        }`}
        title="Set POS vs Invoice source overrides in bulk"
      >
        {hasSplits ? "✦ split" : "split"}
      </button>

      {/* Expanded panel — anchored below the row */}
      {open && (
        <div className="absolute top-full left-0 right-0 z-20 border-t border-blue-900/40 bg-zinc-950 px-4 py-2.5 flex flex-col gap-2 shadow-lg">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[10px] text-blue-400 font-medium uppercase tracking-wider">Source overrides</span>
            <button type="button" onClick={() => setOpen(false)} className="text-[10px] text-zinc-600 hover:text-zinc-300 px-1">✕ close</button>
          </div>
          {/* POS row */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-16 shrink-0">POS</span>
            <div className="flex-1 min-w-0">
              <AccountSelect value={draftPos} onChange={setDraftPos} accounts={accounts} placeholder="— select account —" />
            </div>
            <button onClick={() => apply("chart_of_accounts_id_pos", draftPos, false)} disabled={applying || !draftPos}
              className="px-2 py-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-30 text-white text-[10px] rounded whitespace-nowrap transition-colors">
              {applying ? "…" : "Fill unmapped"}
            </button>
            <button onClick={() => apply("chart_of_accounts_id_pos", draftPos, true)} disabled={applying || !draftPos}
              className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 text-zinc-300 text-[10px] rounded whitespace-nowrap transition-colors">
              Overwrite all
            </button>
          </div>
          {/* Invoice row */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-16 shrink-0">Invoice</span>
            <div className="flex-1 min-w-0">
              <AccountSelect value={draftInv} onChange={setDraftInv} accounts={accounts} placeholder="— select account —" />
            </div>
            <button onClick={() => apply("chart_of_accounts_id_invoice", draftInv, false)} disabled={applying || !draftInv}
              className="px-2 py-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-30 text-white text-[10px] rounded whitespace-nowrap transition-colors">
              {applying ? "…" : "Fill unmapped"}
            </button>
            <button onClick={() => apply("chart_of_accounts_id_invoice", draftInv, true)} disabled={applying || !draftInv}
              className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 text-zinc-300 text-[10px] rounded whitespace-nowrap transition-colors">
              Overwrite all
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default function AccountMappingPage() {
  const [accounts, setAccounts] = useState<CoAAccount[]>([]);
  const [variations, setVariations] = useState<VariationRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [syncing, setSyncing]   = useState(false);
  const [syncResult, setSyncResult] = useState<{ items: number; variations: number } | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems]           = useState<Set<string>>(new Set());

  const loadAll = useCallback(async () => {
    try {
      const [coaRes, mappingsRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch("/api/finance/account-mappings"),
      ]);
      const [coa, maps] = await Promise.all([coaRes.json(), mappingsRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setVariations(Array.isArray(maps) ? maps : []);
    } catch {
      setError("Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleSync() {
    setSyncing(true); setSyncResult(null); setError(null);
    try {
      const res = await fetch("/api/finance/sync-catalog", { method: "POST" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = "Sync failed";
        try { msg = (JSON.parse(text) as { error?: string }).error ?? msg; } catch { msg = text || msg; }
        setError(msg);
        return;
      }
      const json = await res.json();
      setSyncResult(json);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function applyToVariations(
    predicate: (v: VariationRow) => boolean,
    accountId: string,
    overwrite: boolean
  ) {
    const acct = accounts.find((a) => a.id === accountId) ?? null;
    setVariations((vs) =>
      vs.map((v) => {
        if (!predicate(v)) return v;
        if (!overwrite && v.chart_of_accounts_id) return v;
        return {
          ...v,
          chart_of_accounts_id: accountId,
          chart_of_accounts: acct ? { account_name: acct.account_name, account_number: acct.account_number, account_type: acct.account_type } : null,
        };
      })
    );
  }

  async function handleBulkCategory(categoryId: string | null, accountId: string | null, overwrite: boolean) {
    if (!accountId) return;
    const res = await fetch("/api/finance/account-mappings/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category_id: categoryId, chart_of_accounts_id: accountId, overwrite }),
    });
    if (!res.ok) return;
    applyToVariations(
      (v) => categoryId === null ? !v.square_catalog_items?.category_id : v.square_catalog_items?.category_id === categoryId,
      accountId, overwrite
    );
  }

  async function handleBulkParent(parentGroupId: string | null, accountId: string | null, overwrite: boolean) {
    if (!accountId) return;
    const res = await fetch("/api/finance/account-mappings/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_group_id: parentGroupId, chart_of_accounts_id: accountId, overwrite }),
    });
    if (!res.ok) return;
    applyToVariations((v) => {
      const item = v.square_catalog_items;
      if (!item) return false;
      const effectiveParent = item.parent_category_id ?? item.category_id ?? null;
      return effectiveParent === parentGroupId;
    }, accountId, overwrite);
  }

  async function handleBulkItem(catalogItemId: string, accountId: string | null, overwrite: boolean) {
    if (!accountId) return;
    const res = await fetch("/api/finance/account-mappings/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog_item_id: catalogItemId, chart_of_accounts_id: accountId, overwrite }),
    });
    if (!res.ok) return;
    applyToVariations(
      (v) => v.square_catalog_items?.id === catalogItemId,
      accountId, overwrite
    );
  }

  function applySourceToVariations(
    predicate: (v: VariationRow) => boolean,
    field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice",
    accountId: string,
    overwrite: boolean
  ) {
    const acct = accounts.find((a) => a.id === accountId) ?? null;
    const coaField = field === "chart_of_accounts_id_pos" ? "coa_pos" : "coa_invoice";
    setVariations((vs) =>
      vs.map((v) => {
        if (!predicate(v)) return v;
        if (!overwrite && v[field]) return v;
        return { ...v, [field]: accountId, [coaField]: acct ? { account_name: acct.account_name, account_number: acct.account_number, account_type: acct.account_type } : null };
      })
    );
  }

  async function handleBulkSourceParent(
    parentGroupId: string | null,
    field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice",
    accountId: string | null,
    overwrite: boolean
  ) {
    if (!accountId) return;
    const res = await fetch("/api/finance/account-mappings/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_group_id: parentGroupId, [field]: accountId, overwrite }),
    });
    if (!res.ok) return;
    applySourceToVariations((v) => {
      const item = v.square_catalog_items;
      if (!item) return false;
      return (item.parent_category_id ?? item.category_id ?? null) === parentGroupId;
    }, field, accountId, overwrite);
  }

  async function handleBulkSourceCategory(
    categoryId: string | null,
    field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice",
    accountId: string | null,
    overwrite: boolean
  ) {
    if (!accountId) return;
    const res = await fetch("/api/finance/account-mappings/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category_id: categoryId, [field]: accountId, overwrite }),
    });
    if (!res.ok) return;
    applySourceToVariations(
      (v) => categoryId === null ? !v.square_catalog_items?.category_id : v.square_catalog_items?.category_id === categoryId,
      field, accountId, overwrite
    );
  }

  async function handleBulkSourceItem(
    catalogItemId: string,
    field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice",
    accountId: string | null,
    overwrite: boolean
  ) {
    if (!accountId) return;
    const res = await fetch("/api/finance/account-mappings/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog_item_id: catalogItemId, [field]: accountId, overwrite }),
    });
    if (!res.ok) return;
    applySourceToVariations(
      (v) => v.square_catalog_items?.id === catalogItemId,
      field, accountId, overwrite
    );
  }

  async function handleSave(squareVariationId: string, accountId: string | null) {
    await fetch("/api/finance/account-mappings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ square_variation_id: squareVariationId, chart_of_accounts_id: accountId }),
    });
    const acct = accounts.find((a) => a.id === accountId) ?? null;
    setVariations((vs) =>
      vs.map((v) =>
        v.square_variation_id === squareVariationId
          ? { ...v, chart_of_accounts_id: accountId, chart_of_accounts: acct ? { account_name: acct.account_name, account_number: acct.account_number, account_type: acct.account_type } : null }
          : v
      )
    );
  }

  async function handleSaveSource(
    squareVariationId: string,
    field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice",
    accountId: string | null
  ) {
    await fetch("/api/finance/account-mappings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ square_variation_id: squareVariationId, [field]: accountId }),
    });
    const acct = accounts.find((a) => a.id === accountId) ?? null;
    const coaField = field === "chart_of_accounts_id_pos" ? "coa_pos" : "coa_invoice";
    setVariations((vs) =>
      vs.map((v) =>
        v.square_variation_id === squareVariationId
          ? { ...v, [field]: accountId, [coaField]: acct ? { account_name: acct.account_name, account_number: acct.account_number, account_type: acct.account_type } : null }
          : v
      )
    );
  }

  async function handleSaveDeposit(
    squareVariationId: string,
    field: "bs_chart_of_accounts_id" | "pl_chart_of_accounts_id",
    accountId: string | null
  ) {
    await fetch("/api/finance/account-mappings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ square_variation_id: squareVariationId, [field]: accountId }),
    });
    const acct = accounts.find((a) => a.id === accountId) ?? null;
    const coaField = field === "bs_chart_of_accounts_id" ? "coa_bs" : "coa_pl";
    setVariations((vs) =>
      vs.map((v) =>
        v.square_variation_id === squareVariationId
          ? { ...v, [field]: accountId, [coaField]: acct ? { account_name: acct.account_name, account_number: acct.account_number, account_type: acct.account_type } : null }
          : v
      )
    );
  }

  // Group: parent category → subcategory → item → variations
  // Items with no parent_category_id go directly under a top-level group using their own category name.
  const parentMap = new Map<string, GroupedParent>();

  for (const v of variations) {
    const item = v.square_catalog_items;
    if (!item) continue;

    const parentId   = item.parent_category_id ?? item.category_id ?? "__uncategorized__";
    const parentName = item.parent_category_name ?? item.category_name ?? "Uncategorized";
    const catId      = item.category_id ?? "__uncategorized__";
    const catName    = item.category_name ?? "Uncategorized";

    if (!parentMap.has(parentId)) {
      parentMap.set(parentId, { parent_id: item.parent_category_id ?? item.category_id, parent_name: parentName, subcategories: [] });
    }
    const parent = parentMap.get(parentId)!;

    let sub = parent.subcategories.find((s) => s.category_id === catId);
    if (!sub) {
      sub = { category_id: item.category_id, category_name: catName, items: [] };
      parent.subcategories.push(sub);
    }

    let gi = sub.items.find((i) => i.square_item_id === item.square_item_id);
    if (!gi) {
      gi = { square_item_id: item.square_item_id, item_name: item.item_name, is_archived: item.is_archived, variations: [] };
      sub.items.push(gi);
    }
    gi.variations.push(v);
  }

  const groups = [...parentMap.values()].sort((a, b) => a.parent_name.localeCompare(b.parent_name));
  const totalVariations = variations.length;
  const mappedVariations = variations.filter((v) => v.chart_of_accounts_id).length;

  function toggleCategory(key: string) {
    setExpandedCategories((s) => { const n = new Set(s); if (n.has(key)) { n.delete(key); } else { n.add(key); } return n; });
  }
  function toggleItem(key: string) {
    setExpandedItems((s) => { const n = new Set(s); if (n.has(key)) { n.delete(key); } else { n.add(key); } return n; });
  }

  if (loading) return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile /><SettingsNav />
      <div className="flex-1 flex items-center justify-center"><p className="text-xs text-zinc-500">Loading…</p></div>
    </div>
  );

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />

      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-zinc-100">Account Mapping</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {totalVariations > 0
              ? `${mappedVariations} of ${totalVariations} variations mapped`
              : "Sync the catalog first to load variations."}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {syncResult && (
            <span className="text-xs text-green-400">{syncResult.items} items · {syncResult.variations} variations synced</span>
          )}
          <button onClick={handleSync} disabled={syncing}
            className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 text-xs rounded border border-zinc-700 transition-colors">
            {syncing ? "Syncing…" : "Sync Catalog"}
          </button>
        </div>
      </div>
      <SettingsNav />

      {error && <p className="text-xs text-red-400 px-4 sm:px-6 py-2">{error}</p>}

      {accounts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-zinc-400">Upload a chart of accounts first.</p>
            <p className="text-xs text-zinc-600 mt-1">Go to Chart of Accounts → Upload CSV.</p>
          </div>
        </div>
      ) : variations.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-zinc-400">No catalog items yet.</p>
            <p className="text-xs text-zinc-600 mt-1">Click &ldquo;Sync Catalog&rdquo; to pull from Square.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto pb-8">
          <div className="divide-y divide-zinc-800/60">
            {groups.map((parent) => {
              const parentKey     = parent.parent_id ?? "__uncategorized__";
              const isParentExpanded = expandedCategories.has(parentKey);
              const allVars        = parent.subcategories.flatMap((s) => s.items.flatMap((i) => i.variations));
              const parentMapped   = allVars.filter((v) => v.chart_of_accounts_id).length;
              const parentTotal    = allVars.length;
              const parentHasSplit   = allVars.some((v) => v.chart_of_accounts_id_pos || v.chart_of_accounts_id_invoice);
              const parentHasDeposit = allVars.some((v) => v.bs_chart_of_accounts_id || v.pl_chart_of_accounts_id);

              return (
                <div key={parentKey}>
                  {/* Parent category row */}
                  <div className="relative px-4 sm:px-6 py-3 bg-zinc-900 border-b border-zinc-800">
                    <div className="flex items-center gap-3 min-w-0">
                      <button onClick={() => toggleCategory(parentKey)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                        <span className="text-zinc-500 text-xs w-3 shrink-0">{isParentExpanded ? "▾" : "▸"}</span>
                        <span className="text-sm font-semibold text-zinc-100 truncate">{parent.parent_name}</span>
                        <span className="text-[10px] text-zinc-600 shrink-0">{parentTotal} var.</span>
                        {parentMapped > 0 && parentMapped < parentTotal && (
                          <span className="text-[10px] text-amber-500 shrink-0">{parentMapped}/{parentTotal}</span>
                        )}
                        {parentMapped === parentTotal && parentTotal > 0 && (
                          <span className="text-[10px] text-green-500 shrink-0">✓ all</span>
                        )}
                        {parentHasSplit && (
                          <span className="text-[10px] text-blue-400 shrink-0 px-1 bg-blue-900/30 rounded">split</span>
                        )}
                        {parentHasDeposit && (
                          <span className="text-[10px] text-violet-400 shrink-0 px-1 bg-violet-900/30 rounded">deposit</span>
                        )}
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <BulkMapper
                          unmappedCount={parentTotal - parentMapped}
                          accounts={accounts}
                          onApply={(accountId, overwrite) => handleBulkParent(parent.parent_id, accountId, overwrite)}
                        />
                        <BulkSourceMapper
                          accounts={accounts}
                          hasSplits={parentHasSplit}
                          onApply={(field, accountId, overwrite) => handleBulkSourceParent(parent.parent_id, field, accountId, overwrite)}
                        />
                      </div>
                    </div>
                  </div>

                  {isParentExpanded && parent.subcategories
                    .sort((a, b) => a.category_name.localeCompare(b.category_name))
                    .map((cat) => {
                      const catKey       = cat.category_id ?? "__uncategorized__";
                      const isCatExpanded = expandedCategories.has(catKey);
                      const catVars       = cat.items.flatMap((i) => i.variations);
                      const catMapped     = catVars.filter((v) => v.chart_of_accounts_id).length;
                      const catTotal      = catVars.length;
                      const catHasSplit    = catVars.some((v) => v.chart_of_accounts_id_pos || v.chart_of_accounts_id_invoice);
                      const catHasDeposit  = catVars.some((v) => v.bs_chart_of_accounts_id || v.pl_chart_of_accounts_id);

                      // If parent === subcategory (top-level item with no parent), skip the extra level
                      const isSingleLevel = parentKey === catKey;

                      return (
                        <div key={catKey}>
                          {/* Subcategory row — only shown when there's actual nesting */}
                          {!isSingleLevel && (
                            <div className="relative pl-8 pr-4 sm:pr-6 py-2.5 bg-zinc-900/40 border-b border-zinc-800/50">
                              <div className="flex items-center gap-3 min-w-0">
                                <button onClick={() => toggleCategory(catKey)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                                  <span className="text-zinc-600 text-xs w-3 shrink-0">{isCatExpanded ? "▾" : "▸"}</span>
                                  <span className="text-xs font-semibold text-zinc-300 truncate">{cat.category_name}</span>
                                  <span className="text-[10px] text-zinc-600 shrink-0">{catTotal} var.</span>
                                  {catMapped > 0 && catMapped < catTotal && (
                                    <span className="text-[10px] text-amber-500 shrink-0">{catMapped}/{catTotal}</span>
                                  )}
                                  {catMapped === catTotal && catTotal > 0 && (
                                    <span className="text-[10px] text-green-500 shrink-0">✓ all</span>
                                  )}
                                  {catHasSplit && (
                                    <span className="text-[10px] text-blue-400 shrink-0 px-1 bg-blue-900/30 rounded">split</span>
                                  )}
                                  {catHasDeposit && (
                                    <span className="text-[10px] text-violet-400 shrink-0 px-1 bg-violet-900/30 rounded">deposit</span>
                                  )}
                                </button>
                                <div className="flex items-center gap-2 shrink-0">
                                  <BulkMapper
                                    unmappedCount={catTotal - catMapped}
                                    accounts={accounts}
                                    onApply={(accountId, overwrite) => handleBulkCategory(cat.category_id, accountId, overwrite)}
                                  />
                                  <BulkSourceMapper
                                    accounts={accounts}
                                    hasSplits={catHasSplit}
                                    onApply={(field, accountId, overwrite) => handleBulkSourceCategory(cat.category_id, field, accountId, overwrite)}
                                  />
                                </div>
                              </div>
                            </div>
                          )}

                          {(isSingleLevel ? isParentExpanded : isCatExpanded) && cat.items
                            .sort((a, b) => a.item_name.localeCompare(b.item_name))
                            .map((item) => {
                            const itemKey = item.square_item_id;
                            const isItemExpanded = expandedItems.has(itemKey);
                            const itemMapped     = item.variations.filter((v) => v.chart_of_accounts_id).length;
                            const itemHasSplit   = item.variations.some((v) => v.chart_of_accounts_id_pos || v.chart_of_accounts_id_invoice);
                            const itemHasDeposit = item.variations.some((v) => v.bs_chart_of_accounts_id || v.pl_chart_of_accounts_id);

                            return (
                      <div key={itemKey}>
                        {/* Item row */}
                        {(() => {
                          const catalogItemId = item.variations[0]?.square_catalog_items?.id ?? null;
                          return (
                            <div className={`relative pr-4 sm:pr-6 py-2.5 border-t border-zinc-800/30 ${isSingleLevel ? "pl-8" : "pl-14"}`}>
                              <div className="flex items-center gap-3 min-w-0">
                                <button
                                  onClick={() => toggleItem(itemKey)}
                                  className="flex items-center gap-2 flex-1 min-w-0 text-left">
                                  <span className="text-zinc-700 text-xs w-3 shrink-0">{isItemExpanded ? "▾" : "▸"}</span>
                                  <span className={`text-xs font-medium flex-1 truncate ${item.is_archived ? "text-zinc-600 line-through" : "text-zinc-200"}`}>
                                    {item.item_name}
                                  </span>
                                  <span className="text-[10px] text-zinc-600 shrink-0">{item.variations.length} var.</span>
                                  {itemMapped > 0 && itemMapped < item.variations.length && (
                                    <span className="text-[10px] text-amber-600 shrink-0">{itemMapped}/{item.variations.length}</span>
                                  )}
                                  {itemMapped === item.variations.length && item.variations.length > 0 && (
                                    <span className="text-[10px] text-green-500 shrink-0">✓</span>
                                  )}
                                  {itemHasSplit && (
                                    <span className="text-[10px] text-blue-400 shrink-0 px-1 bg-blue-900/30 rounded">split</span>
                                  )}
                                  {itemHasDeposit && (
                                    <span className="text-[10px] text-violet-400 shrink-0 px-1 bg-violet-900/30 rounded">deposit</span>
                                  )}
                                </button>
                                {catalogItemId && (
                                  <div className="flex items-center gap-2 shrink-0">
                                    <BulkMapper
                                      unmappedCount={item.variations.length - itemMapped}
                                      accounts={accounts}
                                      onApply={(accountId, overwrite) => handleBulkItem(catalogItemId, accountId, overwrite)}
                                    />
                                    <BulkSourceMapper
                                      accounts={accounts}
                                      hasSplits={itemHasSplit}
                                      onApply={(field, accountId, overwrite) => handleBulkSourceItem(catalogItemId, field, accountId, overwrite)}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Variation sub-header + rows */}
                        {isItemExpanded && (
                          <>
                            <div className="flex items-center gap-3 pl-6 pr-4 py-1 bg-zinc-900/60 border-t border-zinc-800/40">
                              <span className="text-[10px] text-zinc-600 uppercase tracking-wider w-44 shrink-0">Variation · Price</span>
                              <span className="text-[10px] text-zinc-600 uppercase tracking-wider flex-1">Default GL Account</span>
                              <span className="text-[10px] text-zinc-600 uppercase tracking-wider w-14 text-right">Split</span>
                            </div>
                            {item.variations.map((v) => (
                              <VariationMappingRow
                                key={v.square_variation_id}
                                variation={v}
                                accounts={accounts}
                                onSave={handleSave}
                                onSaveSource={handleSaveSource}
                                onSaveDeposit={handleSaveDeposit}
                              />
                            ))}
                          </>
                        )}
                            </div>
                          );
                        })}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
