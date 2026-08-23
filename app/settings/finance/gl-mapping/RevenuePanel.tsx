"use client";
/**
 * Square catalog variations → Chart of Accounts. This is where revenue gets its
 * GL coding, and it feeds the P&L income side plus Transactions › Orders and
 * Invoices.
 *
 * Not built on MappingFrame like its three siblings: this is a collapsible
 * parent → subcategory → item → variation tree with bulk mappers at every
 * level and per-variation POS/Invoice split overrides, not a flat table. The
 * shared frame would have had to grow a second shape to hold it.
 */
import { useState, useEffect, useCallback, type ReactNode } from "react";
import AccountSelect from "@/app/finance/AccountSelect";
import Banner from "@/app/components/ui/Banner";
import type { Tone } from "@/app/components/ui/tone";
import SaveHint from "@/app/components/ui/SaveHint";
import ToggleChip from "@/app/components/ui/ToggleChip";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import { SPLIT_CATEGORY_CLS } from "@/app/finance/lib/categoryColors";

/** Mapped, or intentionally excluded — either way there is nothing left to do here. */
function isResolved(v: { chart_of_accounts_id: string | null; excluded: boolean }): boolean {
  return !!v.chart_of_accounts_id || v.excluded;
}

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
  excluded: boolean;
  chart_of_accounts: { account_name: string; account_number: string | null; account_type: string } | null;
  coa_pos: { account_name: string; account_number: string | null; account_type: string } | null;
  coa_invoice: { account_name: string; account_number: string | null; account_type: string } | null;
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

function VariationMappingRow({
  variation,
  accounts,
  onSave,
  onSaveSource,
  onSaveExcluded,
}: {
  variation: VariationRow;
  accounts: CoAAccount[];
  onSave: (squareVariationId: string, accountId: string | null) => Promise<void>;
  onSaveSource: (squareVariationId: string, field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice", accountId: string | null) => Promise<void>;
  onSaveExcluded: (squareVariationId: string, excluded: boolean) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const hasSplit   = !!(variation.chart_of_accounts_id_pos || variation.chart_of_accounts_id_invoice);
  const [splitOpen, setSplitOpen]     = useState(false);

  async function handleChange(accountId: string | null) {
    setSaving(true);
    await onSave(variation.square_variation_id, accountId);
    setSaving(false);
  }

  async function handleExcludedChange(excluded: boolean) {
    setSaving(true);
    await onSaveExcluded(variation.square_variation_id, excluded);
    setSaving(false);
  }

  async function handleSourceChange(field: "chart_of_accounts_id_pos" | "chart_of_accounts_id_invoice", accountId: string | null) {
    setSaving(true);
    await onSaveSource(variation.square_variation_id, field, accountId);
    setSaving(false);
  }

  async function handleClearSplit() {
    setSaving(true);
    await onSaveSource(variation.square_variation_id, "chart_of_accounts_id_pos", null);
    await onSaveSource(variation.square_variation_id, "chart_of_accounts_id_invoice", null);
    setSaving(false);
    setSplitOpen(false);
  }

  const price = fmtPrice(variation.price_amount, variation.price_currency, variation.pricing_type);

  return (
    <div className="border-t border-line/30">
      {/* Main row */}
      <div className="flex items-center gap-3 pl-6 pr-4 py-2.5 bg-canvas/40 hover:bg-surface/30 transition-colors">
        {/* Left: variation name + price */}
        <div className="w-44 shrink-0 min-w-0">
          <div className="text-xs text-body truncate">{variation.variation_name}</div>
          <div className="text-2xs text-faint tabular-nums mt-0.5">{price}</div>
        </div>
        {/* Middle: default GL account */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <SaveHint saving={saving} />
          {variation.excluded ? (
            <span className="text-2xs text-faint" title="This variation was marked excluded from mapping">
              excluded
            </span>
          ) : (
            <AccountSelect
              value={variation.chart_of_accounts_id}
              onChange={handleChange}
              accounts={accounts}
              placeholder="— no mapping —"
              shortLabel
              className="w-full max-w-[360px]"
            />
          )}
        </div>
        {/* Right: toggles */}
        <div className="flex items-center gap-1.5 shrink-0">
          <ToggleChip active={variation.excluded} onClick={() => handleExcludedChange(!variation.excluded)}>
            excluded
          </ToggleChip>
          {!variation.excluded && (
            <ToggleChip
              active={hasSplit}
              onClick={() => setSplitOpen((o) => !o)}
              className="whitespace-nowrap"
            >
              {splitOpen ? "▴ split" : "split ▾"}
            </ToggleChip>
          )}
        </div>
      </div>

      {/* Source override rows (POS / Invoice) */}
      {!variation.excluded && splitOpen && (
        <div className="pl-6 pr-4 pb-3 pt-2 flex flex-col gap-2 bg-info-surface/10 border-t border-info-border/20">
          <div className="flex items-center gap-3">
            <span className="text-2xs text-muted w-16 shrink-0 text-right">POS</span>
            <AccountSelect
              value={variation.chart_of_accounts_id_pos}
              onChange={(id) => handleSourceChange("chart_of_accounts_id_pos", id)}
              accounts={accounts}
              placeholder="— same as default —"
            shortLabel
            className="w-full max-w-[360px]"
          />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xs text-muted w-16 shrink-0 text-right">Invoice</span>
            <AccountSelect
              value={variation.chart_of_accounts_id_invoice}
              onChange={(id) => handleSourceChange("chart_of_accounts_id_invoice", id)}
              accounts={accounts}
              placeholder="— same as default —"
            shortLabel
            className="w-full max-w-[360px]"
          />
          </div>
          {hasSplit && (
            <button type="button" onClick={handleClearSplit} className="btn-danger btn-xxs self-end">
              Clear overrides
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A standing GL default recorded when a scope was bulk-mapped. The catalog sync
 * applies it to variations it has never seen, so an item Square adds tomorrow
 * inherits the decision already made for its category instead of arriving
 * unresolved. Server-side counterpart: lib/finance/glDefaultRules.ts.
 */
interface GlDefaultRule {
  scope: "parent" | "category" | "item";
  scope_key: string | null;
  chart_of_accounts_id: string | null;
  chart_of_accounts_id_pos: string | null;
  chart_of_accounts_id_invoice: string | null;
  excluded: boolean | null;
}

function shortAccount(accounts: CoAAccount[], id: string | null): string | null {
  if (!id) return null;
  const a = accounts.find((x) => x.id === id);
  if (!a) return null;
  return a.account_number ? `${a.account_number}` : a.account_name;
}

/**
 * Shows that this scope auto-applies to new variations, and is the only way to
 * revoke it. Removing the rule leaves every mapping it has already made in
 * place — those are real codings a person asked for.
 */
function AutoRuleChip({
  rule,
  accounts,
  onRemove,
}: {
  rule: GlDefaultRule;
  accounts: CoAAccount[];
  onRemove: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const parts: string[] = [];
  const dflt = shortAccount(accounts, rule.chart_of_accounts_id);
  if (dflt) parts.push(dflt);
  const pos = shortAccount(accounts, rule.chart_of_accounts_id_pos);
  if (pos) parts.push(`POS ${pos}`);
  const inv = shortAccount(accounts, rule.chart_of_accounts_id_invoice);
  if (inv) parts.push(`INV ${inv}`);
  if (rule.excluded) parts.push("excluded");
  if (parts.length === 0) return null;

  const label = `auto → ${parts.join(" · ")}`;

  return (
    <>
      <span
        title={`New Square variations in this group are automatically set to ${parts.join(", ")}. Click to stop.`}
        className="text-2xs shrink-0 px-1 rounded border border-info-border/60 bg-info-surface/50 text-info cursor-pointer"
        onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
      >
        {label} ✕
      </span>
      {confirming && (
        <ConfirmDialog
          title="Stop auto-mapping new items?"
          message="New Square variations in this group will arrive unmapped again. Everything already mapped keeps its account — this only removes the standing rule."
          confirmLabel="Remove rule"
          tone="danger"
          busy={busy}
          onConfirm={async () => { setBusy(true); await onRemove(); setBusy(false); setConfirming(false); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
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
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  async function apply(ow: boolean) {
    if (!draft) return;
    setApplying(true);
    await onApply(draft, ow);
    setDraft(null);
    setApplying(false);
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <AccountSelect value={draft} onChange={setDraft} accounts={accounts} placeholder="Bulk map…"
            shortLabel
            className="w-full max-w-[360px]"
          />
      {draft && (
        <>
          <button
            onClick={() => apply(false)}
            disabled={applying || unmappedCount === 0}
            title={`Fill ${unmappedCount} unmapped`}
            className="btn-primary whitespace-nowrap">
            {applying ? "…" : `Fill ${unmappedCount}`}
          </button>
          <button
            onClick={() => setConfirmOverwrite(true)}
            disabled={applying}
            title="Overwrite all"
            className="btn-secondary whitespace-nowrap ml-1">
            Overwrite all
          </button>
        </>
      )}
      {confirmOverwrite && (
        <ConfirmDialog
          title="Overwrite all mappings?"
          message="This replaces every existing GL mapping in this group, not just the unmapped ones. This can't be undone."
          confirmLabel="Overwrite all"
          tone="danger"
          busy={applying}
          onConfirm={() => { apply(true); setConfirmOverwrite(false); }}
          onCancel={() => setConfirmOverwrite(false)}
        />
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
      <ToggleChip
        active={hasSplits}
        onClick={() => setOpen((o) => !o)}
        className="shrink-0"
      >
        {hasSplits ? "✦ split" : "split"}
      </ToggleChip>

      {/* Expanded panel — anchored below the row */}
      {open && (
        <div className="absolute top-full left-0 right-0 z-20 border-t border-info-border/40 bg-canvas px-4 py-2.5 flex flex-col gap-2 shadow-lg">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-2xs text-info font-medium uppercase tracking-wider">Source overrides</span>
            <button type="button" onClick={() => setOpen(false)} className="btn-secondary btn-xxs">✕ close</button>
          </div>
          {/* POS row */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-secondary w-16 shrink-0">POS</span>
            <div className="flex-1 min-w-0">
              <AccountSelect value={draftPos} onChange={setDraftPos} accounts={accounts} placeholder="— select account —"
            shortLabel
            className="w-full max-w-[360px]"
          />
            </div>
            <button onClick={() => apply("chart_of_accounts_id_pos", draftPos, false)} disabled={applying || !draftPos}
              className="btn-primary whitespace-nowrap">
              {applying ? "…" : "Fill unmapped"}
            </button>
            <button onClick={() => apply("chart_of_accounts_id_pos", draftPos, true)} disabled={applying || !draftPos}
              className="btn-secondary whitespace-nowrap">
              Overwrite all
            </button>
          </div>
          {/* Invoice row */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-secondary w-16 shrink-0">Invoice</span>
            <div className="flex-1 min-w-0">
              <AccountSelect value={draftInv} onChange={setDraftInv} accounts={accounts} placeholder="— select account —"
            shortLabel
            className="w-full max-w-[360px]"
          />
            </div>
            <button onClick={() => apply("chart_of_accounts_id_invoice", draftInv, false)} disabled={applying || !draftInv}
              className="btn-primary whitespace-nowrap">
              {applying ? "…" : "Fill unmapped"}
            </button>
            <button onClick={() => apply("chart_of_accounts_id_invoice", draftInv, true)} disabled={applying || !draftInv}
              className="btn-secondary whitespace-nowrap">
              Overwrite all
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function BulkExcluder({
  unresolvedCount,
  totalCount,
  onApply,
}: {
  unresolvedCount: number;
  totalCount: number;
  onApply: (overwrite: boolean) => Promise<void>;
}) {
  const [open, setOpen]         = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  async function apply(ow: boolean) {
    setApplying(true);
    await onApply(ow);
    setApplying(false);
    setOpen(false);
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <ToggleChip
        active={open}
        onClick={() => setOpen((o) => !o)}
        disabled={totalCount === 0}
        className={open ? "border-danger-border bg-danger-surface/60 text-danger" : ""}
      >
        {open ? "▴ exclude" : "exclude ▾"}
      </ToggleChip>
      {open && (
        <>
          <button
            onClick={() => apply(false)}
            disabled={applying || unresolvedCount === 0}
            title={`Exclude ${unresolvedCount} unresolved`}
            className="btn-primary whitespace-nowrap">
            {applying ? "…" : `Exclude ${unresolvedCount}`}
          </button>
          <button
            onClick={() => setConfirmOverwrite(true)}
            disabled={applying}
            title="Exclude all, including already-mapped"
            className="btn-secondary whitespace-nowrap">
            Exclude all
          </button>
        </>
      )}
      {confirmOverwrite && (
        <ConfirmDialog
          title="Exclude all variations?"
          message="This marks every variation in this group as excluded, including ones that already have a GL mapping. Existing mappings are kept, just hidden from revenue coding — undo any one row from its own toggle."
          confirmLabel="Exclude all"
          tone="danger"
          busy={applying}
          onConfirm={() => { apply(true); setConfirmOverwrite(false); }}
          onCancel={() => setConfirmOverwrite(false)}
        />
      )}
    </div>
  );
}

export default function RevenuePanel({ selector }: { selector?: ReactNode }) {
  const [accounts, setAccounts] = useState<CoAAccount[]>([]);
  const [variations, setVariations] = useState<VariationRow[]>([]);
  const [rules, setRules] = useState<GlDefaultRule[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [syncing, setSyncing]   = useState(false);
  const [syncResult, setSyncResult] = useState<{ items: number; variations: number } | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems]           = useState<Set<string>>(new Set());

  const loadAll = useCallback(async () => {
    try {
      const [coaRes, mappingsRes, rulesRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch("/api/finance/account-mappings"),
        fetch("/api/finance/account-mappings/rules"),
      ]);
      const [coa, maps, ruleRows] = await Promise.all([coaRes.json(), mappingsRes.json(), rulesRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setVariations(Array.isArray(maps) ? maps : []);
      setRules(Array.isArray(ruleRows) ? ruleRows : []);
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

  function ruleFor(scope: GlDefaultRule["scope"], key: string | null): GlDefaultRule | undefined {
    return rules.find((r) => r.scope === scope && r.scope_key === key);
  }

  /**
   * Mirror what the bulk route records server-side, so the chip appears the
   * moment a bulk map is applied rather than after the next reload.
   */
  function noteRule(scope: GlDefaultRule["scope"], key: string | null, fields: Partial<GlDefaultRule>) {
    setRules((rs) => {
      const i = rs.findIndex((r) => r.scope === scope && r.scope_key === key);
      if (i === -1) {
        return [...rs, {
          scope, scope_key: key,
          chart_of_accounts_id: null, chart_of_accounts_id_pos: null,
          chart_of_accounts_id_invoice: null, excluded: null,
          ...fields,
        }];
      }
      const next = [...rs];
      next[i] = { ...next[i], ...fields };
      return next;
    });
  }

  async function handleRemoveRule(scope: GlDefaultRule["scope"], key: string | null) {
    const res = await fetch("/api/finance/account-mappings/rules", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, scope_key: key }),
    });
    if (!res.ok) return;
    setRules((rs) => rs.filter((r) => !(r.scope === scope && r.scope_key === key)));
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
        // Excluded rows are skipped server-side too (see the bulk route) — kept
        // in sync here so the optimistic update doesn't briefly show otherwise.
        if (v.excluded) return v;
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
    noteRule("category", categoryId, { chart_of_accounts_id: accountId });
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
    noteRule("parent", parentGroupId, { chart_of_accounts_id: accountId });
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
    noteRule("item", catalogItemId, { chart_of_accounts_id: accountId });
    applyToVariations(
      (v) => v.square_catalog_items?.id === catalogItemId,
      accountId, overwrite
    );
  }

  function applyExcludedToVariations(predicate: (v: VariationRow) => boolean, overwrite: boolean) {
    setVariations((vs) =>
      vs.map((v) => {
        if (!predicate(v)) return v;
        if (v.excluded) return v;
        // Fill only reaches truly-unresolved rows; overwrite reaches every row in
        // scope, mapped or not — mirrors the server-side filter in the bulk route.
        if (!overwrite && v.chart_of_accounts_id) return v;
        return { ...v, excluded: true };
      })
    );
  }

  async function handleBulkExcludeParent(parentGroupId: string | null, overwrite: boolean) {
    const res = await fetch("/api/finance/account-mappings/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_group_id: parentGroupId, excluded: true, overwrite }),
    });
    if (!res.ok) return;
    noteRule("parent", parentGroupId, { excluded: true });
    applyExcludedToVariations((v) => {
      const item = v.square_catalog_items;
      if (!item) return false;
      return (item.parent_category_id ?? item.category_id ?? null) === parentGroupId;
    }, overwrite);
  }

  async function handleBulkExcludeCategory(categoryId: string | null, overwrite: boolean) {
    const res = await fetch("/api/finance/account-mappings/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category_id: categoryId, excluded: true, overwrite }),
    });
    if (!res.ok) return;
    noteRule("category", categoryId, { excluded: true });
    applyExcludedToVariations(
      (v) => categoryId === null ? !v.square_catalog_items?.category_id : v.square_catalog_items?.category_id === categoryId,
      overwrite
    );
  }

  async function handleBulkExcludeItem(catalogItemId: string, overwrite: boolean) {
    const res = await fetch("/api/finance/account-mappings/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog_item_id: catalogItemId, excluded: true, overwrite }),
    });
    if (!res.ok) return;
    noteRule("item", catalogItemId, { excluded: true });
    applyExcludedToVariations((v) => v.square_catalog_items?.id === catalogItemId, overwrite);
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
        if (v.excluded) return v;
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
    noteRule("parent", parentGroupId, { [field]: accountId });
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
    noteRule("category", categoryId, { [field]: accountId });
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
    noteRule("item", catalogItemId, { [field]: accountId });
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

  async function handleSaveExcluded(squareVariationId: string, excluded: boolean) {
    await fetch("/api/finance/account-mappings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ square_variation_id: squareVariationId, excluded }),
    });
    setVariations((vs) =>
      vs.map((v) => (v.square_variation_id === squareVariationId ? { ...v, excluded } : v))
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
  // Excluded variations will never get a GL account — a person already
  // decided that — so they drop out of the denominator instead of reading as
  // permanently unmapped.
  const excludedVariations = variations.filter((v) => v.excluded).length;
  const variationsNeedingMapping = totalVariations - excludedVariations;
  const mappedVariations = variations.filter((v) => v.chart_of_accounts_id && !v.excluded).length;
  // Danger draws the eye when something still needs a decision; success confirms
  // there's nothing left to do; neutral covers "no data yet" / "all excluded".
  const summaryTone: Tone = totalVariations === 0 || variationsNeedingMapping === 0
    ? "neutral"
    : mappedVariations === variationsNeedingMapping ? "success" : "danger";

  function toggleCategory(key: string) {
    setExpandedCategories((s) => { const n = new Set(s); if (n.has(key)) { n.delete(key); } else { n.add(key); } return n; });
  }
  function toggleItem(key: string) {
    setExpandedItems((s) => { const n = new Set(s); if (n.has(key)) { n.delete(key); } else { n.add(key); } return n; });
  }

  if (loading) return (
    <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
  );

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2 flex items-start justify-between gap-4">
        {selector}
        <Banner tone={summaryTone} className="flex-1">
          {totalVariations === 0
            ? "Sync the catalog first to load variations."
            : variationsNeedingMapping === 0
            ? `All ${totalVariations} variations excluded from mapping`
            : `${mappedVariations} of ${variationsNeedingMapping} variations mapped`
              + (excludedVariations > 0 ? ` (${excludedVariations} excluded)` : "")}
        </Banner>
        <div className="flex items-center gap-2 shrink-0">
          {syncResult && (
            <span className="text-xs text-success">{syncResult.items} items · {syncResult.variations} variations synced</span>
          )}
          <button onClick={handleSync} disabled={syncing} className="btn-secondary">
            {syncing ? "Syncing…" : "Sync Catalog"}
          </button>
        </div>
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}

      {accounts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">Upload a chart of accounts first.</p>
            <p className="text-xs text-faint mt-1">Go to Chart of Accounts → Upload CSV.</p>
          </div>
        </div>
      ) : variations.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No catalog items yet.</p>
            <p className="text-xs text-faint mt-1">Click &ldquo;Sync Catalog&rdquo; to pull from Square.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto pb-8">
          <div className="divide-y divide-line/60">
            {groups.map((parent) => {
              const parentKey     = parent.parent_id ?? "__uncategorized__";
              const isParentExpanded = expandedCategories.has(parentKey);
              const allVars        = parent.subcategories.flatMap((s) => s.items.flatMap((i) => i.variations));
              // "Mapped" here means resolved — has an account, or was marked excluded.
              const parentMapped   = allVars.filter(isResolved).length;
              const parentTotal    = allVars.length;
              const parentHasSplit   = allVars.some((v) => v.chart_of_accounts_id_pos || v.chart_of_accounts_id_invoice);

              return (
                <div key={parentKey}>
                  {/* Parent category row */}
                  <div className="relative px-4 sm:px-6 py-3 bg-surface border-b border-line">
                    <div className="flex items-center gap-3 min-w-0">
                      <button onClick={() => toggleCategory(parentKey)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                        <span className="text-muted text-xs w-3 shrink-0">{isParentExpanded ? "▾" : "▸"}</span>
                        <span className="text-sm font-semibold text-primary truncate">{parent.parent_name}</span>
                        <span className="text-2xs text-faint shrink-0">{parentTotal} var.</span>
                        {parentMapped > 0 && parentMapped < parentTotal && (
                          <span className="text-2xs text-accent-emphasis shrink-0">{parentMapped}/{parentTotal}</span>
                        )}
                        {parentMapped === parentTotal && parentTotal > 0 && (
                          <span className="text-2xs text-success shrink-0">✓ all</span>
                        )}
                        {parentHasSplit && (
                          <span className={`text-2xs shrink-0 px-1 rounded ${SPLIT_CATEGORY_CLS}`}>split</span>
                        )}
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        {(() => { const r = ruleFor("parent", parent.parent_id); return r ? (
                          <AutoRuleChip rule={r} accounts={accounts} onRemove={() => handleRemoveRule("parent", parent.parent_id)} />
                        ) : null; })()}
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
                        <BulkExcluder
                          unresolvedCount={parentTotal - parentMapped}
                          totalCount={parentTotal}
                          onApply={(overwrite) => handleBulkExcludeParent(parent.parent_id, overwrite)}
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
                      const catMapped     = catVars.filter(isResolved).length;
                      const catTotal      = catVars.length;
                      const catHasSplit    = catVars.some((v) => v.chart_of_accounts_id_pos || v.chart_of_accounts_id_invoice);

                      // If parent === subcategory (top-level item with no parent), skip the extra level
                      const isSingleLevel = parentKey === catKey;

                      return (
                        <div key={catKey}>
                          {/* Subcategory row — only shown when there's actual nesting */}
                          {!isSingleLevel && (
                            <div className="relative pl-8 pr-4 sm:pr-6 py-2.5 bg-surface/40 border-b border-line/50">
                              <div className="flex items-center gap-3 min-w-0">
                                <button onClick={() => toggleCategory(catKey)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                                  <span className="text-faint text-xs w-3 shrink-0">{isCatExpanded ? "▾" : "▸"}</span>
                                  <span className="text-xs font-semibold text-body truncate">{cat.category_name}</span>
                                  <span className="text-2xs text-faint shrink-0">{catTotal} var.</span>
                                  {catMapped > 0 && catMapped < catTotal && (
                                    <span className="text-2xs text-accent-emphasis shrink-0">{catMapped}/{catTotal}</span>
                                  )}
                                  {catMapped === catTotal && catTotal > 0 && (
                                    <span className="text-2xs text-success shrink-0">✓ all</span>
                                  )}
                                  {catHasSplit && (
                                    <span className={`text-2xs shrink-0 px-1 rounded ${SPLIT_CATEGORY_CLS}`}>split</span>
                                  )}
                                </button>
                                <div className="flex items-center gap-2 shrink-0">
                                  {(() => { const r = ruleFor("category", cat.category_id); return r ? (
                                    <AutoRuleChip rule={r} accounts={accounts} onRemove={() => handleRemoveRule("category", cat.category_id)} />
                                  ) : null; })()}
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
                                  <BulkExcluder
                                    unresolvedCount={catTotal - catMapped}
                                    totalCount={catTotal}
                                    onApply={(overwrite) => handleBulkExcludeCategory(cat.category_id, overwrite)}
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
                            const itemMapped     = item.variations.filter(isResolved).length;
                            const itemHasSplit   = item.variations.some((v) => v.chart_of_accounts_id_pos || v.chart_of_accounts_id_invoice);

                            return (
                      <div key={itemKey}>
                        {/* Item row */}
                        {(() => {
                          const catalogItemId = item.variations[0]?.square_catalog_items?.id ?? null;
                          return (
                            <div className={`relative pr-4 sm:pr-6 py-2.5 border-t border-line/30 ${isSingleLevel ? "pl-8" : "pl-14"}`}>
                              <div className="flex items-center gap-3 min-w-0">
                                <button
                                  onClick={() => toggleItem(itemKey)}
                                  className="flex items-center gap-2 flex-1 min-w-0 text-left">
                                  <span className="text-disabled text-xs w-3 shrink-0">{isItemExpanded ? "▾" : "▸"}</span>
                                  <span className={`text-xs font-medium flex-1 truncate ${item.is_archived ? "text-faint line-through" : "text-strong"}`}>
                                    {item.item_name}
                                  </span>
                                  <span className="text-2xs text-faint shrink-0">{item.variations.length} var.</span>
                                  {itemMapped > 0 && itemMapped < item.variations.length && (
                                    <span className="text-2xs text-accent-border shrink-0">{itemMapped}/{item.variations.length}</span>
                                  )}
                                  {itemMapped === item.variations.length && item.variations.length > 0 && (
                                    <span className="text-2xs text-success shrink-0">✓</span>
                                  )}
                                  {itemHasSplit && (
                                    <span className={`text-2xs shrink-0 px-1 rounded ${SPLIT_CATEGORY_CLS}`}>split</span>
                                  )}
                                </button>
                                {catalogItemId && (
                                  <div className="flex items-center gap-2 shrink-0">
                                    {(() => { const r = ruleFor("item", catalogItemId); return r ? (
                                      <AutoRuleChip rule={r} accounts={accounts} onRemove={() => handleRemoveRule("item", catalogItemId)} />
                                    ) : null; })()}
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
                                    <BulkExcluder
                                      unresolvedCount={item.variations.length - itemMapped}
                                      totalCount={item.variations.length}
                                      onApply={(overwrite) => handleBulkExcludeItem(catalogItemId, overwrite)}
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
                            <div className="flex items-center gap-3 pl-6 pr-4 py-1 bg-surface/60 border-t border-line/40">
                              <span className="text-2xs text-faint uppercase tracking-wider w-44 shrink-0">Variation · Price</span>
                              <span className="text-2xs text-faint uppercase tracking-wider flex-1">Default GL Account</span>
                              <span className="text-2xs text-faint uppercase tracking-wider w-14 text-right">Split</span>
                            </div>
                            {item.variations.map((v) => (
                              <VariationMappingRow
                                key={v.square_variation_id}
                                variation={v}
                                accounts={accounts}
                                onSave={handleSave}
                                onSaveSource={handleSaveSource}
                                onSaveExcluded={handleSaveExcluded}
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
    </>
  );
}
