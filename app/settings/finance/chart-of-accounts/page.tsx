"use client";
import { Fragment, useState, useCallback, useEffect } from "react";
import { type TabDef } from "@/app/components/TabBar";
import ButtonGroup from "@/app/components/ButtonGroup";
import SettingsHeader from "@/app/settings/SettingsHeader";
import { ACCOUNT_TYPE_SECTION, type StatementSection } from "@/lib/finance/accountSections";
import { parseCoaCsv, type ParsedCoaRow } from "@/lib/finance/coaCsv";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";

// ── Constants ─────────────────────────────────────────────────────────────────

const ACCOUNT_TYPES = [
  "Bank",
  "Accounts receivable (A/R)",
  "Other Current Assets",
  "Fixed Assets",
  "Other Assets",
  "Accounts payable (A/P)",
  "Credit Card",
  "Other Current Liabilities",
  "Long Term Liabilities",
  "Equity",
  "Income",
  "Cost of Goods Sold",
  "Expenses",
  "Other Income",
  "Other Expense",
];

// The same 15 keys the section map is built from. This was a second hand-kept
// copy of that union; aliasing means a section added to accountSections.ts can
// no longer go missing here.
type SectionKey = StatementSection;

const SECTION_LABELS: Record<SectionKey, string> = {
  revenue:                   "Revenue (Income)",
  other_income:              "Other Income",
  cogs:                      "Cost of Goods Sold",
  expenses:                  "Operating Expenses",
  other_expense:             "Other Expense",
  bank:                      "Bank & Cash",
  ar:                        "Accounts Receivable",
  other_current_assets:      "Other Current Assets",
  fixed_assets:              "Fixed Assets",
  other_assets:              "Other Assets",
  ap:                        "Accounts Payable",
  credit_card:               "Credit Cards",
  other_current_liabilities: "Other Current Liabilities",
  long_term_liabilities:     "Long-Term Liabilities",
  equity:                    "Equity",
};

const PL_SECTIONS:  SectionKey[] = ["revenue","other_income","cogs","expenses","other_expense"];
const BS_SECTIONS:  SectionKey[] = ["bank","ar","other_current_assets","fixed_assets","other_assets","ap","credit_card","other_current_liabilities","long_term_liabilities","equity"];

// ── Types ─────────────────────────────────────────────────────────────────────

interface CoAAccount {
  id: string;
  account_name: string;
  account_number: string | null;
  account_type: string;
  detail_type: string | null;
  description: string | null;
  is_active: boolean;
  uploaded_at: string;
  parent_id: string | null;
  statement_section: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(dt: string) {
  return new Date(dt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Which statement section an account renders under, or null when its type maps
 * to nothing we know — those collect in the Uncategorized block at the bottom.
 * Returning null beats the old `"other" as SectionKey` cast, which lied to the
 * type system about a key that has no label and no section list.
 */
function effectiveSection(a: CoAAccount): SectionKey | null {
  if (a.statement_section && a.statement_section in SECTION_LABELS)
    return a.statement_section as SectionKey;
  return ACCOUNT_TYPE_SECTION[a.account_type] ?? null;
}

// ── Inline Edit Row ───────────────────────────────────────────────────────────

function EditPanel({
  account,
  accounts,
  onSave,
  onClose,
  onDeleted,
}: {
  account: CoAAccount;
  accounts: CoAAccount[];
  onSave: (updated: CoAAccount) => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [form, setForm] = useState({
    account_name:      account.account_name,
    account_number:    account.account_number ?? "",
    account_type:      account.account_type,
    detail_type:       account.detail_type ?? "",
    description:       account.description ?? "",
    is_active:         account.is_active,
    parent_id:         account.parent_id ?? "",
    statement_section: account.statement_section ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true); setError(null);
    try {
      const res = await fetch(`/api/finance/chart-of-accounts?id=${account.id}`, { method: "DELETE" });
      const json = await res.json();
      if (res.ok) {
        setConfirmingDelete(false);
        onDeleted(account.id);
        return;
      }
      if (res.status === 409 && Array.isArray(json.references)) {
        const parts = (json.references as { source: string; count: number }[])
          .map((r) => `${r.count} ${r.source}`)
          .join(", ");
        setError(`Can't delete — still used by: ${parts}. Reassign or clear those first.`);
      } else {
        setError(json.error ?? "Failed to delete");
      }
      setConfirmingDelete(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  // Collect all descendant ids to prevent creating cycles
  function getDescendants(id: string): Set<string> {
    const result = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      accounts.forEach((a) => { if (a.parent_id === cur && !result.has(a.id)) { result.add(a.id); queue.push(a.id); } });
    }
    return result;
  }
  const descendants = getDescendants(account.id);
  const parentOptions = accounts.filter((a) => a.id !== account.id && !descendants.has(a.id));

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/finance/chart-of-accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id:               account.id,
          account_name:     form.account_name.trim(),
          account_number:   form.account_number.trim() || null,
          account_type:     form.account_type,
          detail_type:      form.detail_type.trim() || null,
          description:      form.description.trim() || null,
          is_active:        form.is_active,
          parent_id:        form.parent_id || null,
          statement_section: form.statement_section || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Failed to save"); return; }
      onSave({
        ...account,
        account_name:      form.account_name.trim(),
        account_number:    form.account_number.trim() || null,
        account_type:      form.account_type,
        detail_type:       form.detail_type.trim() || null,
        description:       form.description.trim() || null,
        is_active:         form.is_active,
        parent_id:         form.parent_id || null,
        statement_section: form.statement_section || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally { setSaving(false); }
  }

  return (
    <form onSubmit={handleSave} className="bg-surface/80 border-t border-line-strong px-4 py-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wider text-muted">Account Name <span className="text-danger">*</span></label>
          <input required value={form.account_name} onChange={(e) => setForm((f) => ({ ...f, account_name: e.target.value }))}
            className="inp-sm w-full" />
        </div>
        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wider text-muted">Account Number</label>
          <input value={form.account_number} onChange={(e) => setForm((f) => ({ ...f, account_number: e.target.value }))}
            placeholder="e.g. 4100"
            className="inp-sm w-full" />
        </div>
        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wider text-muted">Account Type <span className="text-danger">*</span></label>
          <select required value={form.account_type} onChange={(e) => setForm((f) => ({ ...f, account_type: e.target.value }))}
            className="inp-sm w-full">
            {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wider text-muted">Parent Account</label>
          <select value={form.parent_id} onChange={(e) => setForm((f) => ({ ...f, parent_id: e.target.value }))}
            className="inp-sm w-full">
            <option value="">— none (top-level) —</option>
            {parentOptions.sort((a, b) => (a.account_number ?? "").localeCompare(b.account_number ?? "") || a.account_name.localeCompare(b.account_name))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.account_number ? `${a.account_number} · ` : ""}{a.account_name}
                </option>
              ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wider text-muted">
            Statement Section Override
            <span className="ml-1 text-faint normal-case">(auto if blank)</span>
          </label>
          <select value={form.statement_section} onChange={(e) => setForm((f) => ({ ...f, statement_section: e.target.value }))}
            className="inp-sm w-full">
            <option value="">— auto from account type —</option>
            <optgroup label="P&L">
              {PL_SECTIONS.map((s) => <option key={s} value={s}>{SECTION_LABELS[s]}</option>)}
            </optgroup>
            <optgroup label="Balance Sheet">
              {BS_SECTIONS.map((s) => <option key={s} value={s}>{SECTION_LABELS[s]}</option>)}
            </optgroup>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wider text-muted">Detail Type</label>
          <input value={form.detail_type} onChange={(e) => setForm((f) => ({ ...f, detail_type: e.target.value }))}
            placeholder="e.g. Sales of Product Income"
            className="inp-sm w-full" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className="text-2xs uppercase tracking-wider text-muted">Description</label>
          <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Optional description"
            className="inp-sm w-full" />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
              className="accent-[var(--color-accent-emphasis)]" />
            <span className="text-xs text-secondary">Active</span>
          </label>
          <button type="button" onClick={() => setConfirmingDelete(true)}
            className="btn-danger">
            Delete
          </button>
        </div>
        <div className="flex gap-2">
          {error && <span className="text-xs text-danger self-center">{error}</span>}
          <button type="button" onClick={onClose}
            className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="btn-primary">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {confirmingDelete && (
        <ConfirmDialog
          title="Delete account?"
          message={`Delete "${account.account_name}"? This can't be undone.`}
          confirmLabel="Delete"
          tone="danger"
          busy={deleting}
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </form>
  );
}

// ── Statement View ────────────────────────────────────────────────────────────

function renderAccountTree(
  sectionAccounts: CoAAccount[],
  allAccounts: CoAAccount[],
  parentId: string | null,
  indent: number,
  editingId: string | null,
  onEdit: (id: string) => void,
  onSave: (updated: CoAAccount) => void,
  onCloseEdit: () => void,
  onDeleted: (id: string) => void,
): React.ReactNode {
  const sectionIds = new Set(sectionAccounts.map((a) => a.id));
  const children = sectionAccounts.filter((a) => {
    if (parentId === null) {
      // root: parent_id is null OR parent is outside this section
      return !a.parent_id || !sectionIds.has(a.parent_id);
    }
    return a.parent_id === parentId;
  });

  return children.map((acct) => (
    <div key={acct.id}>
      <AccountRow
        account={acct}
        allAccounts={allAccounts}
        indent={indent}
        isEditing={editingId === acct.id}
        onEdit={() => onEdit(acct.id)}
        onSave={onSave}
        onCloseEdit={onCloseEdit}
        onDeleted={onDeleted}
      />
      {renderAccountTree(sectionAccounts, allAccounts, acct.id, indent + 1, editingId, onEdit, onSave, onCloseEdit, onDeleted)}
    </div>
  ));
}

function StatementSection({
  sectionKey,
  accounts,
  allAccounts,
  editingId,
  onEdit,
  onSave,
  onCloseEdit,
  onDeleted,
}: {
  sectionKey: SectionKey;
  accounts: CoAAccount[];
  allAccounts: CoAAccount[];
  editingId: string | null;
  onEdit: (id: string) => void;
  onSave: (updated: CoAAccount) => void;
  onCloseEdit: () => void;
  onDeleted: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  if (accounts.length === 0) return null;

  return (
    <div className="border-b border-line/60">
      <button onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-4 sm:px-6 py-2.5 hover:bg-surface/40 text-left transition-colors">
        <span className="text-faint text-2xs w-3">{expanded ? "▾" : "▸"}</span>
        <span className="text-xs font-semibold text-body uppercase tracking-wider">{SECTION_LABELS[sectionKey]}</span>
        <span className="ml-auto text-2xs text-faint">{accounts.length} account{accounts.length !== 1 ? "s" : ""}</span>
      </button>

      {expanded && (
        <div className="pb-1">
          {renderAccountTree(accounts, allAccounts, null, 0, editingId, onEdit, onSave, onCloseEdit, onDeleted)}
        </div>
      )}
    </div>
  );
}

function AccountRow({
  account,
  allAccounts,
  indent,
  isEditing,
  onEdit,
  onSave,
  onCloseEdit,
  onDeleted,
}: {
  account: CoAAccount;
  allAccounts: CoAAccount[];
  indent: number;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (updated: CoAAccount) => void;
  onCloseEdit: () => void;
  onDeleted: (id: string) => void;
}) {
  const hasOverride = !!account.statement_section;

  return (
    <>
      <button
        onClick={onEdit}
        className={`w-full grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-left border-t border-line/30 transition-colors hover:bg-surface/30 ${isEditing ? "bg-surface/50" : ""} ${!account.is_active ? "opacity-40" : ""}`}
        style={{ paddingLeft: `${(indent + 1) * 1.25 + 0.75}rem`, paddingRight: "1rem", paddingTop: "0.375rem", paddingBottom: "0.375rem" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {indent > 0 && <span className="text-disabled shrink-0 font-mono text-2xs">{"·".repeat(indent)}└</span>}
          {account.account_number && (
            <span className="text-faint font-mono text-xs shrink-0">{account.account_number}</span>
          )}
          <span className="text-xs text-strong truncate">{account.account_name}</span>
          {hasOverride && (
            <span className="text-2xs px-1 py-0.5 rounded bg-accent-muted/40 text-accent border border-accent-border/40 shrink-0">override</span>
          )}
          {!account.is_active && <span className="text-2xs text-faint shrink-0">inactive</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {account.detail_type && (
            <span className="text-2xs text-faint hidden sm:block truncate max-w-[120px]">{account.detail_type}</span>
          )}
          <span className="text-faint text-xs">✎</span>
        </div>
      </button>
      {isEditing && (
        <EditPanel
          account={account}
          accounts={allAccounts}
          onSave={onSave}
          onClose={onCloseEdit}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}

// ── Type View (existing grouped-by-type) ─────────────────────────────────────

function TypeViewTable({ accounts, allAccounts, editingId, onEdit, onSave, onCloseEdit, onDeleted }: {
  accounts: CoAAccount[];
  allAccounts: CoAAccount[];
  editingId: string | null;
  onEdit: (id: string) => void;
  onSave: (updated: CoAAccount) => void;
  onCloseEdit: () => void;
  onDeleted: (id: string) => void;
}) {
  const typeGroups = accounts.reduce<Record<string, CoAAccount[]>>((acc, a) => {
    (acc[a.account_type] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      {Object.entries(typeGroups).sort(([a], [b]) => a.localeCompare(b)).map(([type, rows]) => (
        <div key={type}>
          <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-2">{type}</h3>
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-3 py-2 text-left text-muted font-medium w-6"></th>
                  <th className="px-3 py-2 text-left text-muted font-medium w-24">Number</th>
                  <th className="px-3 py-2 text-left text-muted font-medium">Name</th>
                  <th className="px-3 py-2 text-left text-muted font-medium hidden sm:table-cell">Section</th>
                  <th className="px-3 py-2 text-left text-muted font-medium hidden md:table-cell">Detail Type</th>
                </tr>
              </thead>
              <tbody>
                {rows.sort((a, b) => (a.account_number ?? "").localeCompare(b.account_number ?? "") || a.account_name.localeCompare(b.account_name)).map((a) => {
                  const sec = effectiveSection(a);
                  const hasOverride = !!a.statement_section;
                  // Keyed on the Fragment, not on the inner <tr>: this is the
                  // element the map returns, so it is the one React matches
                  // across renders. With the key one level too deep, React had
                  // no stable identity for the row + its open edit panel.
                  return (
                    <Fragment key={a.id}>
                      <tr
                        onClick={() => onEdit(a.id)}
                        className={`border-t border-line/50 cursor-pointer hover:bg-surface-mid/40 transition-colors ${!a.is_active ? "opacity-40" : ""} ${editingId === a.id ? "bg-surface-mid/60" : ""}`}>
                        <td className="px-3 py-1.5 text-faint text-center">
                          {a.parent_id && <span className="text-disabled">└</span>}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-muted">{a.account_number ?? "—"}</td>
                        <td className="px-3 py-1.5 text-strong">{a.account_name}</td>
                        <td className="px-3 py-1.5 hidden sm:table-cell">
                          <span className={`text-2xs ${hasOverride ? "text-accent" : "text-faint"}`}>
                            {sec ? SECTION_LABELS[sec] : "Uncategorized"}
                            {hasOverride && " ✎"}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-muted hidden md:table-cell">{a.detail_type ?? "—"}</td>
                      </tr>
                      {editingId === a.id && (
                        <tr>
                          <td colSpan={5} className="p-0">
                            <EditPanel
                              account={a}
                              accounts={allAccounts}
                              onSave={onSave}
                              onClose={onCloseEdit}
                              onDeleted={onDeleted}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const BLANK_FORM = { account_name: "", account_number: "", account_type: "", detail_type: "", description: "", is_active: true, parent_id: "", statement_section: "" };

const CoA_VIEW_TABS: TabDef<"statement" | "type">[] = [
  { key: "statement", label: "Statement View" },
  { key: "type", label: "By Type" },
];

export default function ChartOfAccountsPage() {
  const [accounts, setAccounts]   = useState<CoAAccount[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [viewMode, setViewMode]   = useState<"type" | "statement">("statement");
  const [editingId, setEditingId] = useState<string | null>(null);

  // upload state
  const [step, setStep]           = useState<"idle" | "preview" | "done">("idle");
  const [parsed, setParsed]       = useState<ParsedCoaRow[]>([]);
  const [warnings, setWarnings]   = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [inserted, setInserted]   = useState(0);

  // manual add state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm]         = useState(BLANK_FORM);
  const [addError, setAddError]       = useState<string | null>(null);
  const [addSaving, setAddSaving]     = useState(false);

  useEffect(() => {
    fetch("/api/finance/chart-of-accounts")
      .then((r) => r.json())
      .then((d) => { setAccounts(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => { setError("Failed to load chart of accounts."); setLoading(false); });
  }, []);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { rows, warnings: w } = parseCoaCsv(text);
      setParsed(rows);
      setWarnings(w);
      setUploadError(null);
      setStep("preview");
    };
    reader.readAsText(file);
    e.target.value = "";
  }, []);

  async function handleCommit() {
    setSubmitting(true); setUploadError(null);
    try {
      const res = await fetch("/api/finance/chart-of-accounts", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ accounts: parsed }),
      });
      const json = await res.json();
      if (!res.ok) { setUploadError(json.error ?? "Upload failed"); return; }
      setInserted(json.upserted ?? json.inserted ?? 0);
      setStep("done");
      const fresh = await fetch("/api/finance/chart-of-accounts").then((r) => r.json());
      setAccounts(Array.isArray(fresh) ? fresh : []);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Network error");
    } finally { setSubmitting(false); }
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!addForm.account_name.trim() || !addForm.account_type) return;
    setAddSaving(true); setAddError(null);
    try {
      const res = await fetch("/api/finance/chart-of-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keepExtras: true,
          accounts: [{
            account_name:      addForm.account_name.trim(),
            account_number:    addForm.account_number.trim() || null,
            account_type:      addForm.account_type,
            detail_type:       addForm.detail_type.trim() || null,
            description:       addForm.description.trim() || null,
            is_active:         addForm.is_active,
            parent_id:         addForm.parent_id || null,
            statement_section: addForm.statement_section || null,
          }],
        }),
      });
      const json = await res.json();
      if (!res.ok) { setAddError(json.error ?? "Failed to save"); return; }
      setShowAddForm(false);
      setAddForm(BLANK_FORM);
      const fresh = await fetch("/api/finance/chart-of-accounts").then((r) => r.json());
      setAccounts(Array.isArray(fresh) ? fresh : []);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Network error");
    } finally { setAddSaving(false); }
  }

  function handleSaveEdit(updated: CoAAccount) {
    setAccounts((prev) => prev.map((a) => a.id === updated.id ? updated : a));
    setEditingId(null);
  }

  function handleDeleted(id: string) {
    setAccounts((prev) => prev.filter((a) => a.id !== id));
    setEditingId(null);
  }

  function handleEdit(id: string) {
    setEditingId((cur) => cur === id ? null : id);
  }

  const uploadedAt = accounts[0]?.uploaded_at;

  // Build statement view data. PL_SECTIONS + BS_SECTIONS between them cover
  // every SectionKey, so anything left over is an account whose type maps to
  // no section at all — effectiveSection returns null for exactly those.
  const sectionAccounts = (key: SectionKey) => accounts.filter((a) => effectiveSection(a) === key);
  const uncategorized   = accounts.filter((a) => effectiveSection(a) === null);

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6">
        <SettingsHeader
          title="Chart of Accounts"
          description={uploadedAt && !loading ? `${accounts.length} accounts · last uploaded ${fmt(uploadedAt)}` : undefined}
        />
      </div>

      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 sm:py-6 max-w-4xl space-y-6">

        {step === "idle" && (
          <div className="flex items-center justify-between gap-2">
            {!loading && !error && accounts.length > 0 ? (
              <ButtonGroup tabs={CoA_VIEW_TABS} activeKey={viewMode} onSelect={setViewMode} />
            ) : <div />}
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setShowAddForm((v) => !v); setAddError(null); setEditingId(null); }}
                className="btn-secondary">
                {showAddForm ? "Cancel" : "Add Account"}
              </button>
              {/* `relative` anchors the `sr-only` (absolutely positioned)
                  input to this button — see FileUploader.tsx for why an
                  unanchored one scrolls the whole app off-screen when the
                  file dialog opens. */}
              <label className="btn-primary cursor-pointer relative">
                Upload CSV
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={handleFile} />
              </label>
            </div>
          </div>
        )}

        {/* Manual add form */}
        {showAddForm && step === "idle" && (
          <form onSubmit={handleAddAccount} className="bg-surface border border-line rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-strong">Add Account</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-2xs uppercase tracking-wider text-muted">Account Name <span className="text-danger">*</span></label>
                <input required value={addForm.account_name}
                  onChange={(e) => setAddForm((f) => ({ ...f, account_name: e.target.value }))}
                  placeholder="e.g. Merchandise Sales"
                  className="inp-sm w-full" />
              </div>
              <div className="space-y-1">
                <label className="text-2xs uppercase tracking-wider text-muted">Account Number</label>
                <input value={addForm.account_number}
                  onChange={(e) => setAddForm((f) => ({ ...f, account_number: e.target.value }))}
                  placeholder="e.g. 4100"
                  className="inp-sm w-full" />
              </div>
              <div className="space-y-1">
                <label className="text-2xs uppercase tracking-wider text-muted">Account Type <span className="text-danger">*</span></label>
                <select required value={addForm.account_type}
                  onChange={(e) => setAddForm((f) => ({ ...f, account_type: e.target.value }))}
                  className="inp-sm w-full">
                  <option value="">— select type —</option>
                  {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-2xs uppercase tracking-wider text-muted">Parent Account</label>
                <select value={addForm.parent_id}
                  onChange={(e) => setAddForm((f) => ({ ...f, parent_id: e.target.value }))}
                  className="inp-sm w-full">
                  <option value="">— none (top-level) —</option>
                  {/*
                    Rendered straight off `accounts`, which the API already
                    returns ordered by number then name. This used to call
                    .sort() here, which sorts IN PLACE and so mutated the
                    accounts state array every time the Add Account form
                    rendered -- reordering the list behind the statement view
                    without React being told anything had changed.
                  */}
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_number ? `${a.account_number} · ` : ""}{a.account_name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-2xs uppercase tracking-wider text-muted">
                  Statement Section Override
                  <span className="ml-1 text-faint normal-case">(auto if blank)</span>
                </label>
                <select value={addForm.statement_section}
                  onChange={(e) => setAddForm((f) => ({ ...f, statement_section: e.target.value }))}
                  className="inp-sm w-full">
                  <option value="">— auto from account type —</option>
                  <optgroup label="P&L">
                    {PL_SECTIONS.map((s) => <option key={s} value={s}>{SECTION_LABELS[s]}</option>)}
                  </optgroup>
                  <optgroup label="Balance Sheet">
                    {BS_SECTIONS.map((s) => <option key={s} value={s}>{SECTION_LABELS[s]}</option>)}
                  </optgroup>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-2xs uppercase tracking-wider text-muted">Detail Type</label>
                <input value={addForm.detail_type}
                  onChange={(e) => setAddForm((f) => ({ ...f, detail_type: e.target.value }))}
                  placeholder="e.g. Sales of Product Income"
                  className="inp-sm w-full" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-2xs uppercase tracking-wider text-muted">Description</label>
                <input value={addForm.description}
                  onChange={(e) => setAddForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Optional description"
                  className="inp-sm w-full" />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={addForm.is_active}
                  onChange={(e) => setAddForm((f) => ({ ...f, is_active: e.target.checked }))}
                  className="accent-[var(--color-accent-emphasis)]" />
                <span className="text-xs text-secondary">Active</span>
              </label>
            </div>
            {addError && <p className="text-xs text-danger">{addError}</p>}
            <div className="flex gap-3">
              <button type="button" onClick={() => { setShowAddForm(false); setAddForm(BLANK_FORM); setAddError(null); }}
                className="btn-secondary">
                Cancel
              </button>
              <button type="submit" disabled={addSaving}
                className="btn-primary">
                {addSaving ? "Saving…" : "Save Account"}
              </button>
            </div>
          </form>
        )}

        {/* Upload flow */}
        {step === "preview" && (() => {
          const existingByName = new Map(accounts.map((a) => [a.account_name, a]));
          const csvNames       = new Set(parsed.map((a) => a.account_name));

          function hasChanged(csv: ParsedCoaRow, db: CoAAccount) {
            return (
              (csv.account_number ?? null) !== (db.account_number ?? null) ||
              csv.account_type             !== db.account_type ||
              (csv.detail_type ?? null)    !== (db.detail_type ?? null) ||
              (csv.description ?? null)    !== (db.description ?? null) ||
              csv.is_active                !== db.is_active
            );
          }

          type RowStatus = "new" | "updated" | "unchanged";
          const taggedRows: { row: ParsedCoaRow; status: RowStatus }[] = parsed.map((row) => {
            const existing = existingByName.get(row.account_name);
            if (!existing) return { row, status: "new" };
            return { row, status: hasChanged(row, existing) ? "updated" : "unchanged" };
          });

          const toDelete  = accounts.filter((a) => !csvNames.has(a.account_name));
          const newCount  = taggedRows.filter((r) => r.status === "new").length;
          const updCount  = taggedRows.filter((r) => r.status === "updated").length;
          const sameCount = taggedRows.filter((r) => r.status === "unchanged").length;
          const delCount  = toDelete.length;

          return (
            <div className="bg-surface border border-line rounded-lg p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-strong">Review before uploading</h2>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                  {newCount  > 0 && <span className="text-xs text-success"><span className="font-semibold">{newCount}</span> new</span>}
                  {updCount  > 0 && <span className="text-xs text-accent"><span className="font-semibold">{updCount}</span> updated</span>}
                  {sameCount > 0 && <span className="text-xs text-muted"><span className="font-semibold">{sameCount}</span> unchanged</span>}
                  {delCount  > 0 && <span className="text-xs text-danger"><span className="font-semibold">{delCount}</span> deleted</span>}
                </div>
              </div>

              {delCount > 0 && (
                <div className="bg-danger-surface/30 border border-danger-border/50 rounded p-3 space-y-1">
                  <p className="text-xs text-danger font-medium">Accounts to be deleted ({delCount})</p>
                  {toDelete.map((a) => (
                    <p key={a.id} className="text-xs text-danger/70">
                      {a.account_number ? <span className="font-mono mr-1.5">{a.account_number}</span> : null}
                      {a.account_name}
                      <span className="text-danger-border ml-1.5">· {a.account_type}</span>
                    </p>
                  ))}
                </div>
              )}

              {warnings.map((w, i) => (
                <p key={i} className="text-xs text-accent">{w}</p>
              ))}

              {parsed.length > 0 ? (
                <div className="bg-canvas border border-line rounded overflow-hidden max-h-64 overflow-y-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-line sticky top-0 bg-canvas">
                        <th className="px-3 py-2 text-left text-muted font-medium w-20">Status</th>
                        <th className="px-3 py-2 text-left text-muted font-medium">Number</th>
                        <th className="px-3 py-2 text-left text-muted font-medium">Name</th>
                        <th className="px-3 py-2 text-left text-muted font-medium hidden sm:table-cell">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taggedRows.map(({ row, status }, i) => (
                        <tr key={i} className={`border-t border-line/50 ${status === "unchanged" ? "opacity-40" : ""}`}>
                          <td className="px-3 py-1.5">
                            {status === "new"       && <span className="text-success font-medium">New</span>}
                            {status === "updated"   && <span className="text-accent">Updated</span>}
                            {status === "unchanged" && <span className="text-faint">—</span>}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-muted">{row.account_number ?? "—"}</td>
                          <td className="px-3 py-1.5 text-strong">{row.account_name}</td>
                          <td className="px-3 py-1.5 text-secondary hidden sm:table-cell">{row.account_type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-danger">No valid accounts found in CSV. Check that your file has Name and Account Type columns.</p>
              )}

              {uploadError && <p className="text-xs text-danger">{uploadError}</p>}
              <div className="flex gap-3">
                <button onClick={() => { setStep("idle"); setParsed([]); setWarnings([]); }}
                  className="btn-secondary">
                  Cancel
                </button>
                <button onClick={handleCommit} disabled={submitting || parsed.length === 0}
                  className="btn-primary">
                  {submitting ? "Uploading…" : "Apply changes"}
                </button>
              </div>
            </div>
          );
        })()}

        {step === "done" && (() => {
          const parts: string[] = [];
          if (inserted > 0) parts.push(`${inserted} account${inserted !== 1 ? "s" : ""} saved`);
          return (
            <div className="bg-surface border border-line rounded-lg p-5 flex items-center justify-between">
              <p className="text-sm text-success">{parts.join(" · ") || "Upload complete."}</p>
              <button onClick={() => setStep("idle")}
                className="btn-secondary">
                Done
              </button>
            </div>
          );
        })()}

        {/* Account list */}
        {loading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : error ? (
          <p className="text-xs text-danger">{error}</p>
        ) : accounts.length === 0 ? (
          <div className="text-center py-16 space-y-2">
            <p className="text-sm text-secondary">No chart of accounts loaded yet.</p>
            <p className="text-xs text-faint">Upload a QuickBooks Online CSV export to get started.</p>
          </div>
        ) : step === "idle" ? (
          <>
            {viewMode === "statement" ? (
              <div className="bg-surface border border-line rounded-lg overflow-hidden">
                {/* P&L */}
                <div className="px-4 sm:px-6 py-2 bg-surface border-b border-line">
                  <span className="text-xs font-bold text-secondary uppercase tracking-widest">Profit & Loss</span>
                </div>
                {PL_SECTIONS.map((key) => (
                  <StatementSection key={key} sectionKey={key}
                    accounts={sectionAccounts(key)} allAccounts={accounts}
                    editingId={editingId} onEdit={handleEdit}
                    onSave={handleSaveEdit} onCloseEdit={() => setEditingId(null)}
                    onDeleted={handleDeleted} />
                ))}

                {/* Balance Sheet */}
                <div className="px-4 sm:px-6 py-2 bg-surface border-t border-line border-b border-line mt-2">
                  <span className="text-xs font-bold text-secondary uppercase tracking-widest">Balance Sheet</span>
                </div>
                {BS_SECTIONS.map((key) => (
                  <StatementSection key={key} sectionKey={key}
                    accounts={sectionAccounts(key)} allAccounts={accounts}
                    editingId={editingId} onEdit={handleEdit}
                    onSave={handleSaveEdit} onCloseEdit={() => setEditingId(null)}
                    onDeleted={handleDeleted} />
                ))}

                {/* Uncategorized */}
                {uncategorized.length > 0 && (
                  <>
                    <div className="px-4 sm:px-6 py-2 bg-surface border-t border-line mt-2">
                      <span className="text-xs font-bold text-faint uppercase tracking-widest">Uncategorized</span>
                    </div>
                    {uncategorized.map((acct) => (
                      <AccountRow key={acct.id} account={acct} allAccounts={accounts}
                        indent={0}
                        isEditing={editingId === acct.id}
                        onEdit={() => handleEdit(acct.id)}
                        onSave={handleSaveEdit}
                        onCloseEdit={() => setEditingId(null)}
                        onDeleted={handleDeleted} />
                    ))}
                  </>
                )}

                <div className="px-4 sm:px-6 py-2.5 border-t border-line bg-surface/40">
                  <p className="text-2xs text-faint">Click any account to edit. Statement Section Override remaps an account to a different P&L or Balance Sheet section regardless of its Account Type.</p>
                </div>
              </div>
            ) : (
              <TypeViewTable
                accounts={accounts}
                allAccounts={accounts}
                editingId={editingId}
                onEdit={handleEdit}
                onSave={handleSaveEdit}
                onCloseEdit={() => setEditingId(null)}
                onDeleted={handleDeleted}
              />
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
