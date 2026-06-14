"use client";
import { useState, useCallback, useEffect } from "react";
import FinanceNav from "../../FinanceNav";
import SettingsNav from "../SettingsNav";

const ACCOUNT_TYPES = [
  "Bank",
  "Accounts receivable (A/R)",
  "Other Current Assets",
  "Fixed Assets",
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

interface CoAAccount {
  id: string;
  account_name: string;
  account_number: string | null;
  account_type: string;
  detail_type: string | null;
  description: string | null;
  is_active: boolean;
  uploaded_at: string;
}

interface ParsedRow {
  account_name: string;
  account_number: string | null;
  account_type: string;
  detail_type: string | null;
  description: string | null;
  is_active: boolean;
}

// QBO standard export header aliases
const HEADER_MAP: Record<string, keyof ParsedRow> = {
  "name":           "account_name",
  "account name":   "account_name",
  "account":        "account_name",
  "number":         "account_number",
  "account number": "account_number",
  "account no":     "account_number",
  "account no.":    "account_number",
  "type":           "account_type",
  "account type":   "account_type",
  "detail type":    "detail_type",
  "subtype":        "detail_type",
  "description":    "description",
  "active":         "is_active",
};

function parseCSV(text: string): { rows: ParsedRow[]; warnings: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], warnings: ["CSV is empty or has no data rows."] };

  const rawHeaders = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  const colIndex: Partial<Record<keyof ParsedRow, number>> = {};
  for (let i = 0; i < rawHeaders.length; i++) {
    const mapped = HEADER_MAP[rawHeaders[i]];
    if (mapped && !(mapped in colIndex)) colIndex[mapped] = i;
  }

  const warnings: string[] = [];
  if (colIndex.account_name === undefined) warnings.push("Could not find an account name column.");
  if (colIndex.account_type === undefined) warnings.push("Could not find an account type column.");

  const rows: ParsedRow[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const get = (k: keyof ParsedRow) => colIndex[k] !== undefined ? (cells[colIndex[k]!] ?? "") : "";

    const name = get("account_name");
    const type = get("account_type");
    if (!name || !type) continue;

    const activeRaw = get("is_active").toLowerCase();
    const is_active = activeRaw === "" || activeRaw === "yes" || activeRaw === "true" || activeRaw === "1";

    rows.push({
      account_name:   name,
      account_number: get("account_number") || null,
      account_type:   type,
      detail_type:    get("detail_type") || null,
      description:    get("description") || null,
      is_active,
    });
  }

  return { rows, warnings };
}

function fmt(dt: string) {
  return new Date(dt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const BLANK_FORM = { account_name: "", account_number: "", account_type: "", detail_type: "", description: "", is_active: true };

export default function ChartOfAccountsPage() {
  const [accounts, setAccounts]   = useState<CoAAccount[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  // upload state
  const [step, setStep]           = useState<"idle" | "preview" | "done">("idle");
  const [parsed, setParsed]       = useState<ParsedRow[]>([]);
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
      const { rows, warnings: w } = parseCSV(text);
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
      // Reload the list
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
            account_name:   addForm.account_name.trim(),
            account_number: addForm.account_number.trim() || null,
            account_type:   addForm.account_type,
            detail_type:    addForm.detail_type.trim() || null,
            description:    addForm.description.trim() || null,
            is_active:      addForm.is_active,
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

  const uploadedAt = accounts[0]?.uploaded_at;
  const typeGroups = accounts.reduce<Record<string, CoAAccount[]>>((acc, a) => {
    (acc[a.account_type] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <SettingsNav />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4 border-b border-zinc-800 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-zinc-100">Chart of Accounts</h1>
          {uploadedAt && !loading && (
            <p className="text-xs text-zinc-500 mt-0.5">
              {accounts.length} accounts · last uploaded {fmt(uploadedAt)}
            </p>
          )}
        </div>
        {step === "idle" && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { setShowAddForm((v) => !v); setAddError(null); }}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded border border-zinc-700 transition-colors">
              {showAddForm ? "Cancel" : "Add Account"}
            </button>
            <label className="cursor-pointer px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium rounded transition-colors">
              Upload CSV
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={handleFile} />
            </label>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 sm:py-6 max-w-4xl space-y-6">

        {/* Manual add form */}
        {showAddForm && step === "idle" && (
          <form onSubmit={handleAddAccount} className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-200">Add Account</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">Account Name <span className="text-red-400">*</span></label>
                <input
                  required
                  value={addForm.account_name}
                  onChange={(e) => setAddForm((f) => ({ ...f, account_name: e.target.value }))}
                  placeholder="e.g. Merchandise Sales"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-600"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">Account Number</label>
                <input
                  value={addForm.account_number}
                  onChange={(e) => setAddForm((f) => ({ ...f, account_number: e.target.value }))}
                  placeholder="e.g. 4100"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-600"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">Account Type <span className="text-red-400">*</span></label>
                <select
                  required
                  value={addForm.account_type}
                  onChange={(e) => setAddForm((f) => ({ ...f, account_type: e.target.value }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-amber-600">
                  <option value="">— select type —</option>
                  {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">Detail Type</label>
                <input
                  value={addForm.detail_type}
                  onChange={(e) => setAddForm((f) => ({ ...f, detail_type: e.target.value }))}
                  placeholder="e.g. Sales of Product Income"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-600"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">Description</label>
                <input
                  value={addForm.description}
                  onChange={(e) => setAddForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Optional description"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-600"
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={addForm.is_active}
                  onChange={(e) => setAddForm((f) => ({ ...f, is_active: e.target.checked }))}
                  className="accent-amber-500"
                />
                <span className="text-xs text-zinc-400">Active</span>
              </label>
            </div>
            {addError && <p className="text-xs text-red-400">{addError}</p>}
            <div className="flex gap-3">
              <button type="button" onClick={() => { setShowAddForm(false); setAddForm(BLANK_FORM); setAddError(null); }}
                className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={addSaving}
                className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs rounded transition-colors">
                {addSaving ? "Saving…" : "Save Account"}
              </button>
            </div>
          </form>
        )}

        {/* Upload flow */}
        {step === "preview" && (() => {
          const existingByName = new Map(accounts.map((a) => [a.account_name, a]));
          const csvNames       = new Set(parsed.map((a) => a.account_name));

          function hasChanged(csv: ParsedRow, db: CoAAccount) {
            return (
              (csv.account_number ?? null) !== (db.account_number ?? null) ||
              csv.account_type             !== db.account_type ||
              (csv.detail_type ?? null)    !== (db.detail_type ?? null) ||
              (csv.description ?? null)    !== (db.description ?? null) ||
              csv.is_active                !== db.is_active
            );
          }

          type RowStatus = "new" | "updated" | "unchanged";
          const taggedRows: { row: ParsedRow; status: RowStatus }[] = parsed.map((row) => {
            const existing = existingByName.get(row.account_name);
            if (!existing) return { row, status: "new" };
            return { row, status: hasChanged(row, existing) ? "updated" : "unchanged" };
          });

          const toDelete   = accounts.filter((a) => !csvNames.has(a.account_name));
          const newCount   = taggedRows.filter((r) => r.status === "new").length;
          const updCount   = taggedRows.filter((r) => r.status === "updated").length;
          const sameCount  = taggedRows.filter((r) => r.status === "unchanged").length;
          const delCount   = toDelete.length;

          return (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-zinc-200">Review before uploading</h2>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                  {newCount > 0 && <span className="text-xs text-green-400"><span className="font-semibold">{newCount}</span> new</span>}
                  {updCount > 0 && <span className="text-xs text-amber-400"><span className="font-semibold">{updCount}</span> updated</span>}
                  {sameCount > 0 && <span className="text-xs text-zinc-500"><span className="font-semibold">{sameCount}</span> unchanged</span>}
                  {delCount > 0 && <span className="text-xs text-red-400"><span className="font-semibold">{delCount}</span> deleted</span>}
                </div>
              </div>

              {delCount > 0 && (
                <div className="bg-red-950/30 border border-red-900/50 rounded p-3 space-y-1">
                  <p className="text-xs text-red-400 font-medium">Accounts to be deleted ({delCount})</p>
                  {toDelete.map((a) => (
                    <p key={a.id} className="text-xs text-red-300/70">
                      {a.account_number ? <span className="font-mono mr-1.5">{a.account_number}</span> : null}
                      {a.account_name}
                      <span className="text-red-900 ml-1.5">· {a.account_type}</span>
                    </p>
                  ))}
                </div>
              )}

              {warnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-400">{w}</p>
              ))}

              {parsed.length > 0 ? (
                <div className="bg-zinc-950 border border-zinc-800 rounded overflow-hidden max-h-64 overflow-y-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-zinc-800 sticky top-0 bg-zinc-950">
                        <th className="px-3 py-2 text-left text-zinc-500 font-medium w-20">Status</th>
                        <th className="px-3 py-2 text-left text-zinc-500 font-medium">Number</th>
                        <th className="px-3 py-2 text-left text-zinc-500 font-medium">Name</th>
                        <th className="px-3 py-2 text-left text-zinc-500 font-medium hidden sm:table-cell">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taggedRows.map(({ row, status }, i) => (
                        <tr key={i} className={`border-t border-zinc-800/50 ${status === "unchanged" ? "opacity-40" : ""}`}>
                          <td className="px-3 py-1.5">
                            {status === "new"       && <span className="text-green-400 font-medium">New</span>}
                            {status === "updated"   && <span className="text-amber-400">Updated</span>}
                            {status === "unchanged" && <span className="text-zinc-600">—</span>}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-zinc-500">{row.account_number ?? "—"}</td>
                          <td className="px-3 py-1.5 text-zinc-200">{row.account_name}</td>
                          <td className="px-3 py-1.5 text-zinc-400 hidden sm:table-cell">{row.account_type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-red-400">No valid accounts found in CSV. Check that your file has Name and Account Type columns.</p>
              )}

              {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
              <div className="flex gap-3">
                <button onClick={() => { setStep("idle"); setParsed([]); setWarnings([]); }}
                  className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded transition-colors">
                  Cancel
                </button>
                <button onClick={handleCommit} disabled={submitting || parsed.length === 0}
                  className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs rounded transition-colors">
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
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 flex items-center justify-between">
              <p className="text-sm text-green-400">{parts.join(" · ") || "Upload complete."}</p>
              <button onClick={() => setStep("idle")}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded transition-colors">
                Done
              </button>
            </div>
          );
        })()}

        {/* Account list */}
        {loading ? (
          <p className="text-xs text-zinc-500">Loading…</p>
        ) : error ? (
          <p className="text-xs text-red-400">{error}</p>
        ) : accounts.length === 0 ? (
          <div className="text-center py-16 space-y-2">
            <p className="text-sm text-zinc-400">No chart of accounts loaded yet.</p>
            <p className="text-xs text-zinc-600">Upload a QuickBooks Online CSV export to get started.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {Object.entries(typeGroups).sort(([a], [b]) => a.localeCompare(b)).map(([type, rows]) => (
              <div key={type}>
                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">{type}</h3>
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="px-3 py-2 text-left text-zinc-500 font-medium w-24">Number</th>
                        <th className="px-3 py-2 text-left text-zinc-500 font-medium">Name</th>
                        <th className="px-3 py-2 text-left text-zinc-500 font-medium hidden sm:table-cell">Detail Type</th>
                        <th className="px-3 py-2 text-left text-zinc-500 font-medium hidden md:table-cell">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.sort((a, b) => (a.account_number ?? "").localeCompare(b.account_number ?? "") || a.account_name.localeCompare(b.account_name)).map((a) => (
                        <tr key={a.id} className={`border-t border-zinc-800/50 ${!a.is_active ? "opacity-40" : ""}`}>
                          <td className="px-3 py-1.5 font-mono text-zinc-500">{a.account_number ?? "—"}</td>
                          <td className="px-3 py-1.5 text-zinc-200">{a.account_name}</td>
                          <td className="px-3 py-1.5 text-zinc-500 hidden sm:table-cell">{a.detail_type ?? "—"}</td>
                          <td className="px-3 py-1.5 text-zinc-600 hidden md:table-cell truncate max-w-xs">{a.description ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
