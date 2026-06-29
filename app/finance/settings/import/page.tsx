"use client";
import { useState, useCallback } from "react";
import FinanceNav from "../../FinanceNav";
import SettingsNav from "../SettingsNav";
import { autoDetectColumns, buildImportPayloads, type ColumnMap } from "@/lib/finance/qb-csv";
import type { InvoiceImportPayload, InvoiceStatus } from "@/types/finance";

// ── Square sync panel ─────────────────────────────────────────────────────────

function SquareSyncPanel() {
  const currentYear = new Date().getFullYear();
  const [year, setYear]       = useState(currentYear);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult]   = useState<{ synced: number; updated: number; skipped: number; total: number; errors?: string[] } | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  async function handleSync() {
    setSyncing(true); setError(null); setResult(null);
    try {
      const res  = await fetch(`/api/finance/ledger/sync-square?year=${year}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Sync failed"); return; }
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally { setSyncing(false); }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-zinc-200">Sync Square Invoices</h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          Pulls all Square invoices for the selected year into the ledger. Safe to re-run — existing records are updated, not duplicated.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <select value={year} onChange={(e) => { setYear(Number(e.target.value)); setResult(null); }}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={handleSync} disabled={syncing}
          className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs rounded transition-colors">
          {syncing ? "Syncing…" : "Sync"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <div className="flex gap-4">
          {result.synced  > 0 && <Stat n={result.synced}  label="New"     cls="text-green-400" />}
          {result.updated > 0 && <Stat n={result.updated} label="Updated" cls="text-zinc-300"  />}
          {result.skipped > 0 && <Stat n={result.skipped} label="Skipped" cls="text-zinc-500"  />}
          {result.synced === 0 && result.updated === 0 && (
            <p className="text-xs text-zinc-500">No invoices found for {year}.</p>
          )}
          {result.errors?.map((e, i) => <p key={i} className="text-xs text-red-400">{e}</p>)}
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div className="text-center">
      <div className={`text-xl font-bold ${cls}`}>{n}</div>
      <div className="text-[10px] text-zinc-500">{label}</div>
    </div>
  );
}

async function commitInvoices(invoices: InvoiceImportPayload[]) {
  const res = await fetch("/api/finance/ledger/invoices", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ invoices }),
  });
  return res.json() as Promise<{ inserted: number; updated: number; errors?: string[] }>;
}

function fmtDollars(cents: number) {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ── PDF import ────────────────────────────────────────────────────────────────

type ParsedFile = { filename: string; payload: InvoiceImportPayload | null; warnings: string[] };

function PDFImport() {
  const [step, setStep]         = useState<"upload" | "review" | "done">("upload");
  const [parsing, setParsing]   = useState(false);
  const [parsed, setParsed]     = useState<ParsedFile[]>([]);
  const [drafts, setDrafts]     = useState<(InvoiceImportPayload | null)[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult]     = useState<{ inserted: number; updated: number; errors?: string[] } | null>(null);
  const [error, setError]       = useState<string | null>(null);

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type === "application/pdf" || f.name.endsWith(".pdf"));
    if (files.length === 0) return;
    setParsing(true); setError(null);
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      const res  = await fetch("/api/finance/import/parse-pdf", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Parse failed"); return; }
      const results: ParsedFile[] = json.results;
      setParsed(results);
      setDrafts(results.map((r) => r.payload));
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally { setParsing(false); }
  }

  function updateDraft(i: number, patch: Partial<InvoiceImportPayload>) {
    setDrafts((d) => d.map((inv, idx) => idx === i && inv ? { ...inv, ...patch } : inv));
  }

  async function handleCommit() {
    const valid = drafts.filter((d): d is InvoiceImportPayload => d !== null);
    if (!valid.length) return;
    setSubmitting(true); setError(null);
    try {
      const json = await commitInvoices(valid);
      setResult(json); setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally { setSubmitting(false); }
  }

  const statusOptions: InvoiceStatus[] = ["open", "paid", "partial", "draft", "voided", "unknown"];

  return (
    <div className="space-y-4">
      {step === "upload" && (
        <div className="space-y-3">
          <label className={`flex flex-col items-center justify-center w-full h-36 border-2 border-dashed rounded-lg transition-colors ${
            parsing ? "border-amber-700 cursor-wait" : "border-zinc-700 cursor-pointer hover:border-amber-600"
          }`}>
            <span className="text-zinc-400 text-sm">{parsing ? "Parsing PDFs…" : "Click to choose QB invoice PDFs"}</span>
            <span className="text-zinc-600 text-xs mt-1">One or multiple files · .pdf</span>
            <input type="file" accept=".pdf,application/pdf" multiple className="sr-only"
              onChange={handleFiles} disabled={parsing} />
          </label>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}

      {step === "review" && (
        <div className="space-y-4">
          <p className="text-xs text-zinc-400">Review each parsed invoice. Fields highlighted in amber were not detected.</p>
          {parsed.map((file, i) => {
            const draft = drafts[i];
            if (!draft) return (
              <div key={i} className="bg-red-900/20 border border-red-700/50 rounded-lg p-4 space-y-1">
                <p className="text-xs font-medium text-red-300">{file.filename} — parse failed</p>
                {file.warnings.map((w, j) => <p key={j} className="text-[10px] text-red-400">{w}</p>)}
              </div>
            );
            return (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-300">{file.filename}</span>
                  {file.warnings.length > 0 && <span className="text-[10px] text-amber-400">{file.warnings.length} warning{file.warnings.length > 1 ? "s" : ""}</span>}
                </div>
                {file.warnings.length > 0 && (
                  <div className="space-y-0.5">{file.warnings.map((w, j) => <p key={j} className="text-[10px] text-amber-400/80">{w}</p>)}</div>
                )}
                <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                  <Field label="Invoice #" required value={draft.invoice_number} onChange={(v) => updateDraft(i, { invoice_number: v, external_id: v })} />
                  <Field label="Customer" required value={draft.customer_name} onChange={(v) => updateDraft(i, { customer_name: v })} />
                  <Field label="Invoice date" value={draft.invoice_date ?? ""} placeholder="YYYY-MM-DD" onChange={(v) => updateDraft(i, { invoice_date: v || null })} />
                  <Field label="Due date" value={draft.due_date ?? ""} placeholder="YYYY-MM-DD" onChange={(v) => updateDraft(i, { due_date: v || null })} />
                  <div>
                    <label className="block text-[10px] text-zinc-500 mb-1">Status</label>
                    <select value={draft.status} onChange={(e) => updateDraft(i, { status: e.target.value as InvoiceStatus })}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
                      {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-500 mb-1">Total</label>
                    <div className="text-xs text-zinc-300 py-1 font-mono">{fmtDollars(draft.total_cents)}</div>
                  </div>
                </div>
                {draft.line_items.length > 0 && (
                  <div className="mt-1">
                    <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">Line items ({draft.line_items.length})</div>
                    <div className="space-y-1">
                      {draft.line_items.map((li, j) => (
                        <div key={j} className="flex items-center justify-between text-[10px] bg-zinc-800/50 rounded px-2 py-1">
                          <span className="text-zinc-400 flex-1 truncate">{li.description}</span>
                          <span className="text-zinc-500 font-mono ml-3">{fmtDollars(li.total_cents)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button onClick={() => { setStep("upload"); setParsed([]); setDrafts([]); }}
              className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded transition-colors">Back</button>
            <button onClick={handleCommit} disabled={submitting || !drafts.some(Boolean)}
              className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs rounded transition-colors">
              {submitting ? "Importing…" : `Import ${drafts.filter(Boolean).length} invoice${drafts.filter(Boolean).length !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div className="space-y-3">
          <div className="flex gap-4">
            {result.inserted > 0 && <Stat n={result.inserted} label="New"     cls="text-green-400" />}
            {result.updated  > 0 && <Stat n={result.updated}  label="Updated" cls="text-zinc-300"  />}
          </div>
          {result.errors?.map((e, i) => <p key={i} className="text-xs text-red-400">{e}</p>)}
          <button onClick={() => { setStep("upload"); setParsed([]); setDrafts([]); setResult(null); }}
            className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded transition-colors">Import more</button>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, required }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean;
}) {
  const empty = !value;
  return (
    <div>
      <label className="block text-[10px] text-zinc-500 mb-1">
        {label}{required && <span className="text-amber-500 ml-0.5">*</span>}
      </label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className={`w-full rounded px-2 py-1 text-xs text-zinc-200 border focus:outline-none focus:border-amber-600 ${
          empty && required ? "bg-amber-900/20 border-amber-700/60" : "bg-zinc-800 border-zinc-700"
        }`} />
    </div>
  );
}

// ── CSV import ────────────────────────────────────────────────────────────────

const COLUMN_FIELDS: { key: keyof ColumnMap; label: string; required: boolean }[] = [
  { key: "invoice_number", label: "Invoice Number",  required: true  },
  { key: "invoice_date",   label: "Invoice Date",    required: true  },
  { key: "due_date",       label: "Due Date",         required: false },
  { key: "customer_name",  label: "Customer Name",    required: true  },
  { key: "description",    label: "Line Description", required: true  },
  { key: "quantity",       label: "Quantity",          required: false },
  { key: "unit_price",     label: "Unit Price",        required: false },
  { key: "amount",         label: "Line Amount",       required: true  },
  { key: "status",         label: "Status",            required: false },
];

type CSVStep = "upload" | "map" | "preview" | "done";

function CSVImport() {
  const [step, setStep]             = useState<CSVStep>("upload");
  const [csvText, setCsvText]       = useState("");
  const [headers, setHeaders]       = useState<string[]>([]);
  const [colMap, setColMap]         = useState<ColumnMap | null>(null);
  const [invoices, setInvoices]     = useState<InvoiceImportPayload[]>([]);
  const [warnings, setWarnings]     = useState<string[]>([]);
  const [skipped, setSkipped]       = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult]         = useState<{ inserted: number; updated: number; errors?: string[] } | null>(null);
  const [error, setError]           = useState<string | null>(null);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCsvText(text);
      const firstLine = text.split(/\r?\n/)[0] ?? "";
      const hdrs = firstLine.split(",").map((h) => h.replace(/^"|"$/g, "").trim());
      setHeaders(hdrs);
      setColMap(autoDetectColumns(hdrs));
      setStep("map");
    };
    reader.readAsText(file);
  }, []);

  function handleParse() {
    if (!colMap) return;
    const { invoices: parsed, skipped: sk, warnings: warn } = buildImportPayloads(csvText, colMap);
    setInvoices(parsed); setSkipped(sk); setWarnings(warn);
    setStep("preview");
  }

  async function handleCommit() {
    setSubmitting(true); setError(null);
    try {
      const json = await commitInvoices(invoices);
      setResult(json); setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally { setSubmitting(false); }
  }

  function reset() {
    setStep("upload"); setCsvText(""); setHeaders([]); setColMap(null);
    setInvoices([]); setWarnings([]); setSkipped(0); setResult(null); setError(null);
  }

  return (
    <div className="space-y-4">
      {step === "upload" && (
        <label className="flex flex-col items-center justify-center w-full h-36 border-2 border-dashed border-zinc-700 rounded-lg cursor-pointer hover:border-amber-600 transition-colors">
          <span className="text-zinc-400 text-sm">Click to choose a CSV file</span>
          <span className="text-zinc-600 text-xs mt-1">QB transaction export · .csv</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={handleFile} />
        </label>
      )}

      {step === "map" && colMap && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            {COLUMN_FIELDS.map(({ key, label, required }) => (
              <div key={key} className="flex items-center gap-3">
                <span className="w-36 text-xs text-zinc-400 shrink-0">{label}{required && <span className="text-amber-500 ml-0.5">*</span>}</span>
                <select value={colMap[key]} onChange={(e) => setColMap({ ...colMap, [key]: e.target.value })}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
                  <option value="">— skip —</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <button onClick={() => setStep("upload")} className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded">Back</button>
            <button onClick={handleParse}
              disabled={!colMap.invoice_number || !colMap.invoice_date || !colMap.customer_name || !colMap.amount}
              className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs rounded transition-colors">
              Parse →
            </button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex gap-4">
            <Stat n={invoices.length} label="Invoices" cls="text-zinc-200" />
            <Stat n={invoices.reduce((s, i) => s + i.line_items.length, 0)} label="Line items" cls="text-zinc-200" />
            {skipped > 0 && <Stat n={skipped} label="Skipped" cls="text-yellow-400" />}
          </div>
          {warnings.map((w, i) => <p key={i} className="text-xs text-yellow-300">{w}</p>)}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
            <table className="w-full text-xs border-collapse">
              <thead><tr className="border-b border-zinc-800">
                <th className="px-3 py-2 text-left text-zinc-500">Invoice #</th>
                <th className="px-3 py-2 text-left text-zinc-500">Date</th>
                <th className="px-3 py-2 text-left text-zinc-500">Customer</th>
                <th className="px-3 py-2 text-right text-zinc-500">Total</th>
              </tr></thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.invoice_number} className="border-t border-zinc-800/50">
                    <td className="px-3 py-1.5 font-mono text-zinc-300">{inv.invoice_number}</td>
                    <td className="px-3 py-1.5 text-zinc-400">{inv.invoice_date ?? "—"}</td>
                    <td className="px-3 py-1.5 text-zinc-400">{inv.customer_name}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-zinc-300">{fmtDollars(inv.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-3">
            <button onClick={() => setStep("map")} className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded">Back</button>
            <button onClick={handleCommit} disabled={submitting || invoices.length === 0}
              className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs rounded transition-colors">
              {submitting ? "Importing…" : `Import ${invoices.length} invoices`}
            </button>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div className="space-y-3">
          <div className="flex gap-4">
            {result.inserted > 0 && <Stat n={result.inserted} label="New"     cls="text-green-400" />}
            {result.updated  > 0 && <Stat n={result.updated}  label="Updated" cls="text-zinc-300"  />}
          </div>
          {result.errors?.map((e, i) => <p key={i} className="text-xs text-red-400">{e}</p>)}
          <button onClick={reset} className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded">
            Import another file
          </button>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ImportSettingsPage() {
  const [qbMode, setQbMode] = useState<"pdf" | "csv">("pdf");

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4">
        <h1 className="text-base font-semibold text-zinc-100">Import</h1>
        <p className="text-xs text-zinc-500 mt-0.5">Admin only</p>
      </div>
      <SettingsNav />
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 sm:py-6 max-w-3xl space-y-8">
        <SquareSyncPanel />
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-zinc-200">Import QuickBooks Invoices</h2>
              <p className="text-xs text-zinc-500 mt-0.5">For historical invoices that predate Square.</p>
            </div>
            <div className="flex items-center gap-1 bg-zinc-800 rounded p-0.5">
              {(["pdf", "csv"] as const).map((m) => (
                <button key={m} onClick={() => setQbMode(m)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    qbMode === m ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                  }`}>
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {qbMode === "pdf" ? <PDFImport /> : <CSVImport />}
        </div>
      </div>
    </div>
  );
}
