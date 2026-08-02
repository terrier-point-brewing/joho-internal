"use client";

/**
 * Party-agnostic worksheet chrome: page header (party label / period / due
 * date), a read-only masked filing-identity header, `worksheet.warnings` in
 * a banner, a recompute button, a debounced autosave on every field edit,
 * a totals footer, and the complete panel at `#complete-panel`. Selects the
 * party's worksheet React module via `app/finance/tax/parties/registry.ts`,
 * keyed by the party's `worksheetComponent`.
 *
 * Once `task.status === "completed"`, the whole worksheet goes read-only:
 * the Recompute button doesn't render, `handleFieldsChange`/`handleRecompute`
 * are no-ops (so no autosave PATCH or recompute POST can fire), and the
 * party worksheet component is rendered with `readOnly` so its manual
 * fields render display-only. `CompletePanel` already handles its own
 * read-only rendering once the task is completed.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import FinanceNav from "../../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import BackLink from "@/app/components/ui/BackLink";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { fmtCents, fmtDateLong } from "@/lib/utils/formatting";
import type { FieldSpec, TaxTask, WorksheetData } from "@/lib/tax/types";
import type { ResolvedRequiredRegistration } from "@/lib/tax/registrations";
import { useTaxPartiesQuery, useEntityProfileQuery, useLegalRepresentativeQuery, useBankAccountQuery } from "../hooks/useTaxData";
import { bankAccountTypeLabel } from "@/lib/tax/bankAccount";
import { getWorksheetModule } from "../parties/registry";
import CompletePanel from "./CompletePanel";

const AUTOSAVE_DEBOUNCE_MS = 800;

function formatEntityAddress(entity: Record<string, string>): string {
  const street = [entity.address_line1, entity.address_line2].filter(Boolean).join(", ");
  const cityStateZip = [[entity.city, entity.state].filter(Boolean).join(", "), entity.postal_code]
    .filter(Boolean)
    .join(" ");
  return [street, cityStateZip].filter(Boolean).join(" · ") || "—";
}

type SaveState = "idle" | "saving" | "saved" | "error";

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export default function TaxWorksheetShell({ taskId }: { taskId: string }) {
  const qc = useQueryClient();

  const taskQuery = useQuery({
    queryKey: queryKeys.tax.task(taskId),
    queryFn: () => fetchJson<TaxTask>(`/api/tax/tasks/${taskId}`),
  });
  const partiesQuery = useTaxPartiesQuery();
  const task = taskQuery.data;
  const party = partiesQuery.data?.find((p) => p.key === task?.party_key);
  // Once a task is completed/submitted, its figures must be frozen — no
  // autosave PATCH, no recompute POST, no editable manual fields.
  const isCompleted = task?.status === "completed";

  const profileQuery = useQuery({
    queryKey: queryKeys.tax.profile(task?.party_key ?? ""),
    queryFn: () => fetchJson<Record<string, string>>(`/api/tax/profiles/${task!.party_key}`),
    enabled: !!task?.party_key,
  });
  const entityProfileQuery = useEntityProfileQuery();
  const representativeQuery = useLegalRepresentativeQuery();
  const bankAccountQuery = useBankAccountQuery();

  const [worksheet, setWorksheet] = useState<WorksheetData>({ fields: {} });
  // True while a local edit hasn't been confirmed saved yet — guards the
  // load-sync effect below from clobbering an in-progress edit with a stale
  // task refetch.
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Autosave/recompute race guard: the debounced PATCH and the recompute
  // POST can both be in flight at once (e.g. a user edits a manual field,
  // scheduling a PATCH, then immediately clicks Recompute). If the PATCH's
  // response lands AFTER the recompute's, its success handler would call
  // `qc.setQueryData` with the PRE-recompute worksheet, re-firing the
  // load-sync effect below and silently overwriting the freshly recomputed
  // figures. `recomputeGenerationRef` is bumped once per completed
  // recompute; each autosave captures the generation in effect at the
  // moment its PATCH is issued and, when the response comes back, skips
  // applying it if a newer recompute has since completed (current
  // generation > captured generation) — so a recompute's result can never
  // be clobbered by an older in-flight autosave.
  const recomputeGenerationRef = useRef(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeError, setRecomputeError] = useState<string | null>(null);

  useEffect(() => {
    if (task && !dirtyRef.current) {
      setWorksheet(task.worksheet ?? { fields: {} });
    }
  }, [task]);

  // Flush any pending debounce timer on unmount so navigating away mid-edit
  // doesn't leave a dangling timer.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Warn before the tab closes/reloads while there's an unsaved edit —
  // otherwise a failed (or still-debouncing) autosave silently loses the
  // edit on navigation. Active whenever dirtyRef is true (pending or failed
  // save). Keyed on both `worksheet` (changes synchronously on every field
  // edit, the same tick dirtyRef flips true) and `saveState` (changes when
  // the save resolves/fails) so the listener attaches immediately on edit
  // and detaches immediately once a save succeeds, rather than waiting on
  // the debounce timer.
  useEffect(() => {
    if (!dirtyRef.current) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [worksheet, saveState]);

  function scheduleAutosave(next: WorksheetData) {
    dirtyRef.current = true;
    setSaveState("idle");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      // Capture the recompute generation at the moment this PATCH is
      // actually issued (see recomputeGenerationRef comment above).
      const issuedGeneration = recomputeGenerationRef.current;
      setSaveState("saving");
      try {
        const saved = await patchJson<TaxTask>(`/api/tax/tasks/${taskId}`, { worksheet: next });
        if (recomputeGenerationRef.current !== issuedGeneration) {
          // A recompute completed while this autosave was in flight — its
          // response reflects the pre-recompute worksheet, which is now
          // stale. Drop it rather than clobbering the recomputed figures.
          return;
        }
        qc.setQueryData(queryKeys.tax.task(taskId), saved);
        dirtyRef.current = false;
        setSaveState("saved");
      } catch {
        if (recomputeGenerationRef.current !== issuedGeneration) return;
        setSaveState("error");
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function handleFieldsChange(nextFields: Record<string, number | string | null>) {
    if (isCompleted) return;
    setWorksheet((cur) => {
      const next: WorksheetData = { ...cur, fields: nextFields };
      scheduleAutosave(next);
      return next;
    });
  }

  async function handleRecompute() {
    if (isCompleted) return;
    setRecomputing(true);
    setRecomputeError(null);
    try {
      const merged = await postJson<WorksheetData>(`/api/tax/tasks/${taskId}/recompute`);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      // Bump the generation so any autosave PATCH already in flight (issued
      // before this point) gets recognized as stale and skips applying its
      // response once it resolves.
      recomputeGenerationRef.current += 1;
      dirtyRef.current = false;
      setSaveState("idle");
      setWorksheet(merged);
      await qc.invalidateQueries({ queryKey: queryKeys.tax.task(taskId) });
    } catch (err) {
      setRecomputeError(err instanceof Error ? err.message : "Recompute failed.");
    } finally {
      setRecomputing(false);
    }
  }

  if (taskQuery.isLoading || partiesQuery.isLoading) {
    return (
      <main className="px-4 sm:px-6">
        <StickyHeader>
          <FinanceNav mobile />
          <BackLink href="/finance/tax" label="Tax" />
        </StickyHeader>
        <p className="text-sm text-faint mt-4 pb-4 sm:pb-8">Loading…</p>
      </main>
    );
  }

  if (taskQuery.isError || !task) {
    return (
      <main className="px-4 sm:px-6">
        <StickyHeader>
          <FinanceNav mobile />
          <BackLink href="/finance/tax" label="Tax" />
        </StickyHeader>
        <Banner tone="danger" className="mt-4 pb-4 sm:pb-8">
          {taskQuery.error instanceof Error ? taskQuery.error.message : "Task not found."}
        </Banner>
      </main>
    );
  }

  const worksheetModule = party ? getWorksheetModule(party.worksheetComponent) : undefined;
  const totalDueCents = worksheetModule?.getTotalDueCents(worksheet.fields) ?? null;
  const computedAt = typeof worksheet.meta?.computedAt === "string" ? worksheet.meta.computedAt : undefined;

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <FinanceNav mobile />
        <BackLink href="/finance/tax" label="Tax" />
        <PageHeader
          title={party?.label ?? task.party_key}
          description={`Period ${fmtDateLong(task.period_start)} – ${fmtDateLong(task.period_end)} · Due ${fmtDateLong(task.due_date)}`}
        />
      </StickyHeader>

      <div className="pb-4 sm:pb-8">
        <IdentityHeader
          schema={party?.settingsSchema ?? []}
          values={profileQuery.data}
          entity={entityProfileQuery.data}
          representative={representativeQuery.data}
          bankAccount={bankAccountQuery.data}
          requiredRegistrations={party?.requiredRegistrations ?? []}
          isLoading={
            profileQuery.isLoading || entityProfileQuery.isLoading || representativeQuery.isLoading || bankAccountQuery.isLoading
          }
        />

        {worksheet.warnings && worksheet.warnings.length > 0 && (
          <Banner tone="info" className="mt-4">
            <ul className="list-disc pl-4 space-y-1">
              {worksheet.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
        )}
        {recomputeError && (
          <Banner tone="danger" className="mt-4">
            {recomputeError}
          </Banner>
        )}

        {!isCompleted && (
          <div className="flex items-center justify-between mt-4 mb-2">
            <SaveStatus state={saveState} />
            <button className="btn-secondary" onClick={handleRecompute} disabled={recomputing}>
              {recomputing ? "Recomputing…" : (party?.recomputeLabel ?? "Recompute")}
            </button>
          </div>
        )}

        <Card className={isCompleted ? "mt-4" : undefined}>
          {worksheetModule ? (
            <worksheetModule.Worksheet
              fields={worksheet.fields}
              computedAt={computedAt}
              onFieldsChange={handleFieldsChange}
              readOnly={isCompleted}
            />
          ) : (
            <p className="text-sm text-faint">No worksheet UI registered for &ldquo;{task.party_key}&rdquo;.</p>
          )}
        </Card>

        <div className="flex items-center justify-between mt-4 mb-4 border-t border-line pt-4">
          <div>
            <p className="text-xs text-faint uppercase tracking-wide">Total Due</p>
            <p className="text-lg font-semibold text-strong tabular-nums">
              {totalDueCents != null ? fmtCents(totalDueCents) : "—"}
            </p>
          </div>
        </div>

        <div id="complete-panel">
          <CompletePanel taskId={taskId} task={task} />
        </div>
      </div>
    </main>
  );
}

/**
 * Party-agnostic "who is filing" header shown above every party's
 * worksheet, grouped by what the metadata actually describes rather than as
 * one flat list — each group renders only if it has rows, in this order:
 *  1. Registrations & Permits — `requiredRegistrations`, already fully
 *     resolved server-side by `GET /api/tax/parties` (base + this party's
 *     own requirements, matched by (authority_key, key) — never "first row
 *     for this authority"; e.g. the brewery's ABC wholesaler permit vs. the
 *     taproom's ABC on-premise permit are distinct rows here).
 *  2. Business Identity — `entity` (tax_entity_profile): legal name, trade
 *     name, address, phone, fax. Business-level, shared across every party.
 *  3. Representative — `representative` (tax_legal_representative): Name of
 *     Contact Person and State of Domicile (this person's `state`, read
 *     directly — never a separate stored field).
 *  4. Bank Account — `bankAccount` (tax_bank_account): Name of Account,
 *     Account Type, Account Holder, plus a single on-file/not-on-file status
 *     row for the `sensitive` routing/account numbers (never the real
 *     digits — same as the representative's SSN, those are Tax Profile-only).
 *  5. Filing Settings — `schema`/`values` (the party's own `settingsSchema` /
 *     `tax_filing_profiles`): whatever extra identity-ish fields a party
 *     still declares for itself (e.g. NC DOR Sales & Use's Square mapping
 *     fields). Empty for beer excise and Wake County F&B.
 * The representative's `title`, `ssn`, and street address are captured in
 * Tax Profile but intentionally NOT rendered here — the worksheet header
 * only shows what the paper form actually asks for.
 */
function IdentityHeader({
  schema,
  values,
  entity,
  representative,
  bankAccount,
  requiredRegistrations,
  isLoading,
}: {
  schema: FieldSpec[];
  values?: Record<string, string>;
  entity?: Record<string, string>;
  representative?: Record<string, string>;
  bankAccount?: Record<string, string>;
  requiredRegistrations: ResolvedRequiredRegistration[];
  isLoading: boolean;
}) {
  if (isLoading) return <p className="text-xs text-faint mt-2">Loading filing identity…</p>;

  const registrationRows = requiredRegistrations.map((req) => ({
    label: req.label,
    value: req.number || "—",
  }));

  const businessIdentityRows = entity
    ? [
        { label: "Legal Entity Name", value: entity.legal_name || "—" },
        { label: "Trade Name", value: entity.trade_name || "—" },
        { label: "Address", value: formatEntityAddress(entity) },
        { label: "Phone Number", value: entity.contact_phone || "—" },
        { label: "Fax Number", value: entity.fax_number || "—" },
      ]
    : [];

  const representativeRows = representative
    ? [
        { label: "Name of Contact Person", value: representative.name || "—" },
        { label: "State of Domicile", value: representative.state || "—" },
      ]
    : [];

  // Routing/account numbers are `sensitive` — this masked query never carries
  // the real digits, only "present"/"absent" — so the header can only ever
  // confirm one's on file, never show it. See Tax Profile's Unmask control
  // for the real value.
  const bankAccountRows = bankAccount
    ? [
        { label: "Name of Account", value: bankAccount.account_name || "—" },
        { label: "Account Type", value: bankAccountTypeLabel(bankAccount.account_type) },
        { label: "Account Holder", value: bankAccount.account_holder || "—" },
        {
          label: "Routing/Account Number",
          value:
            bankAccount.routing_number === "present" && bankAccount.account_number === "present"
              ? "On file"
              : "Not on file",
        },
      ]
    : [];

  const schemaRows = schema.map((field) => ({ label: field.label, value: values?.[field.key] || "—" }));

  const groups = [
    { title: "Registrations & Permits", rows: registrationRows },
    { title: "Business Identity", rows: businessIdentityRows },
    { title: "Representative", rows: representativeRows },
    { title: "Bank Account", rows: bankAccountRows },
    { title: "Filing Settings", rows: schemaRows },
  ].filter((group) => group.rows.length > 0);
  if (groups.length === 0) return null;

  return (
    <Card className="mt-2" padding="p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Filing Identity</p>
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="text-xs font-medium text-secondary mb-1">{group.title}</p>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
              {group.rows.map((row) => (
                <div key={row.label} className="min-w-0">
                  <dt className="text-xs text-faint">{row.label}</dt>
                  <dd className="text-body truncate">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  const label = { idle: "", saving: "Saving…", saved: "Saved", error: "Autosave failed — will retry on next edit" }[state];
  if (!label) return <span />;
  return <span className={`text-xs ${state === "error" ? "text-danger" : "text-faint"}`}>{label}</span>;
}
