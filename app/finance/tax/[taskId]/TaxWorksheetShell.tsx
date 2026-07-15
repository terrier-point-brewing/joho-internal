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
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { fmtCents, fmtDateLong } from "@/lib/utils/formatting";
import type { FieldSpec, TaxTask, WorksheetData } from "@/lib/tax/types";
import type { TaxRegistration } from "@/lib/tax/registrations";
import { useTaxPartiesQuery, useEntityProfileQuery, useRegistrationsQuery } from "../hooks/useTaxData";
import { getWorksheetModule } from "../parties/registry";
import CompletePanel from "./CompletePanel";

const AUTOSAVE_DEBOUNCE_MS = 800;

// Which tax_registrations authorities are relevant to each party's Filing
// Identity header. FEIN (irs) and the NC DOR account/license # apply to
// every party filed with NC DOR today; the ABC permit is alcohol-specific
// (beer excise only).
const HEADER_REGISTRATION_AUTHORITIES: Record<string, { authorityKey: string; label: string }[]> = {
  nc_dor_beer_excise: [
    { authorityKey: "irs", label: "FEIN" },
    { authorityKey: "nc_dor", label: "NCDOR ID / Account Number" },
    { authorityKey: "nc_abc", label: "ABC Permit Number" },
  ],
  nc_dor_sales_use: [
    { authorityKey: "irs", label: "FEIN" },
    { authorityKey: "nc_dor", label: "NCDOR ID / Account Number" },
  ],
};

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
  const registrationsQuery = useRegistrationsQuery();

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
      <main className="px-4 sm:px-6 py-4 sm:py-8">
        <FinanceNav mobile />
        <p className="text-sm text-faint mt-4">Loading…</p>
      </main>
    );
  }

  if (taskQuery.isError || !task) {
    return (
      <main className="px-4 sm:px-6 py-4 sm:py-8">
        <FinanceNav mobile />
        <Banner tone="danger" className="mt-4">
          {taskQuery.error instanceof Error ? taskQuery.error.message : "Task not found."}
        </Banner>
      </main>
    );
  }

  const worksheetModule = party ? getWorksheetModule(party.worksheetComponent) : undefined;
  const totalDueCents = worksheetModule?.getTotalDueCents(worksheet.fields) ?? null;
  const computedAt = typeof worksheet.meta?.computedAt === "string" ? worksheet.meta.computedAt : undefined;

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <FinanceNav mobile />
      <PageHeader
        title={party?.label ?? task.party_key}
        description={`Period ${fmtDateLong(task.period_start)} – ${fmtDateLong(task.period_end)} · Due ${fmtDateLong(task.due_date)}`}
      />

      <IdentityHeader
        schema={party?.settingsSchema ?? []}
        values={profileQuery.data}
        entity={entityProfileQuery.data}
        registrations={registrationsQuery.data}
        registrationAuthorities={HEADER_REGISTRATION_AUTHORITIES[task.party_key] ?? []}
        isLoading={profileQuery.isLoading || entityProfileQuery.isLoading || registrationsQuery.isLoading}
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
    </main>
  );
}

/**
 * Party-agnostic "who is filing" header shown above every party's
 * worksheet. Three sources, in display order:
 *  1. `registrations` (tax_registrations) filtered to `registrationAuthorities`
 *     — FEIN / NCDOR ID / ABC permit, whichever this party's authorities are.
 *  2. `entity` (tax_entity_profile) — legal name, trade name, address,
 *     contact, state of domicile, phone, fax. Shared across every party.
 *  3. `schema`/`values` (the party's own `settingsSchema` /
 *     `tax_filing_profiles`) — whatever extra identity-ish fields a party
 *     still declares for itself (e.g. NC DOR Sales & Use's Square mapping
 *     fields). Empty for beer excise since Task 2 emptied its schema.
 */
function IdentityHeader({
  schema,
  values,
  entity,
  registrations,
  registrationAuthorities,
  isLoading,
}: {
  schema: FieldSpec[];
  values?: Record<string, string>;
  entity?: Record<string, string>;
  registrations?: TaxRegistration[];
  registrationAuthorities: { authorityKey: string; label: string }[];
  isLoading: boolean;
}) {
  if (isLoading) return <p className="text-xs text-faint mt-2">Loading filing identity…</p>;

  const registrationRows = registrationAuthorities.map(({ authorityKey, label }) => ({
    label,
    value: registrations?.find((r) => r.authority_key === authorityKey)?.number || "—",
  }));

  const entityRows = entity
    ? [
        { label: "Legal Entity Name", value: entity.legal_name || "—" },
        { label: "Trade Name", value: entity.trade_name || "—" },
        { label: "Address", value: formatEntityAddress(entity) },
        { label: "Name of Contact Person", value: entity.contact_name || "—" },
        { label: "State of Domicile", value: entity.state_of_domicile || "—" },
        { label: "Phone Number", value: entity.contact_phone || "—" },
        { label: "Fax Number", value: entity.fax_number || "—" },
      ]
    : [];

  const schemaRows = schema.map((field) => ({ label: field.label, value: values?.[field.key] || "—" }));

  const rows = [...registrationRows, ...entityRows, ...schemaRows];
  if (rows.length === 0) return null;

  return (
    <Card className="mt-2" padding="p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Filing Identity</p>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-xs text-faint">{row.label}</dt>
            <dd className="text-body truncate">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  const label = { idle: "", saving: "Saving…", saved: "Saved", error: "Autosave failed — will retry on next edit" }[state];
  if (!label) return <span />;
  return <span className={`text-xs ${state === "error" ? "text-danger" : "text-faint"}`}>{label}</span>;
}
