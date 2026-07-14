"use client";

/**
 * Task-completion card for the worksheet workspace: confirmation number,
 * amount paid, submitted date, notes, plus the confirmation-file uploader
 * (`FileUploader`). "Mark Submitted" POSTs `/api/tax/tasks/[id]/complete`
 * (Task 12) then invalidates the task query so `TaxWorksheetShell` picks up
 * the new `status`/`completed_*` fields and this component re-renders in
 * its read-only, completed form — a closed task shows the recorded
 * confirmation values and a download-only file list, with no submit button.
 *
 * Money: `amount_paid` is entered in dollars and sent as
 * `amount_paid_cents`; the dollars<->cents string helpers are the same ones
 * `NcDorSalesUse`'s worksheet uses (`lib/tax/ncDorWorksheetMath.ts`), which
 * in turn delegate the numeric crossing to `lib/money.ts` — reused here
 * rather than reimplemented.
 */
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import { Field } from "@/app/components/ui/Modal";
import { queryKeys } from "@/lib/query-keys";
import { fmtCents, fmtDateLong } from "@/lib/utils/formatting";
import { centsToDollarString, dollarStringToCents } from "@/lib/tax/ncDorWorksheetMath";
import type { TaxTask } from "@/lib/tax/types";
import { canSubmitComplete, type CompleteFormState } from "@/lib/tax/completeForm";
import FileUploader from "./FileUploader";

function formStateForTask(task: TaxTask): CompleteFormState {
  return {
    confirmationNumber: task.confirmation_number ?? "",
    amountPaidInput: centsToDollarString(task.amount_paid_cents),
    submittedOn: task.submitted_on ?? new Date().toISOString().slice(0, 10),
    notes: task.notes ?? "",
  };
}

export default function CompletePanel({ taskId, task }: { taskId: string; task: TaxTask }) {
  const qc = useQueryClient();
  const isCompleted = task.status === "completed";

  const [form, setForm] = useState<CompleteFormState>(() => formStateForTask(task));
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setForm(formStateForTask(task));
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setForm(formStateForTask(task));
    setError(null);
    setEditing(false);
  }

  // Completed tasks show a read-only summary by default; a manager can click
  // Edit to correct the recorded confirmation values or add/replace files. The
  // /complete endpoint is a plain update, so re-submitting an edit keeps the
  // task completed (re-stamping completed_at/completed_by to the last editor).
  if (isCompleted && !editing) {
    return (
      <Card>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-faint">Submission Confirmed</p>
          <button type="button" className="btn-secondary btn-xxs" onClick={startEditing}>
            Edit
          </button>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm mb-4">
          <div>
            <dt className="text-xs text-faint">Confirmation #</dt>
            <dd className="text-body truncate">{task.confirmation_number || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Amount Paid</dt>
            <dd className="text-body tabular-nums">
              {task.amount_paid_cents != null ? fmtCents(task.amount_paid_cents) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Submitted</dt>
            <dd className="text-body">{task.submitted_on ? fmtDateLong(task.submitted_on) : "—"}</dd>
          </div>
        </dl>
        {task.notes && <p className="text-sm text-body whitespace-pre-wrap mb-4">{task.notes}</p>}

        <div className="border-t border-line pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Confirmation Files</p>
          <FileUploader taskId={taskId} readOnly />
        </div>
      </Card>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmitComplete(form)) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/tax/tasks/${taskId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation_number: form.confirmationNumber.trim(),
          amount_paid_cents: dollarStringToCents(form.amountPaidInput),
          submitted_on: form.submittedOn,
          notes: form.notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      const updated = await res.json();
      qc.setQueryData(queryKeys.tax.task(taskId), updated);
      await qc.invalidateQueries({ queryKey: queryKeys.tax.task(taskId) });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this filing.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <p className="text-xs font-semibold uppercase tracking-wide text-faint mb-3">
        {isCompleted ? "Edit Submission" : "Complete Filing"}
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <Banner tone="danger">{error}</Banner>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Confirmation Number" required>
            <input
              type="text"
              className="inp"
              value={form.confirmationNumber}
              onChange={(e) => setForm((f) => ({ ...f, confirmationNumber: e.target.value }))}
            />
          </Field>
          <Field label="Amount Paid" required>
            <input
              type="text"
              inputMode="decimal"
              className="inp"
              value={form.amountPaidInput}
              onChange={(e) => setForm((f) => ({ ...f, amountPaidInput: e.target.value }))}
            />
          </Field>
          <Field label="Submitted On" required>
            <input
              type="date"
              className="inp"
              value={form.submittedOn}
              onChange={(e) => setForm((f) => ({ ...f, submittedOn: e.target.value }))}
            />
          </Field>
        </div>

        <Field label="Notes" hint="optional">
          <textarea
            className="inp resize-none"
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </Field>

        <div className="border-t border-line pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Confirmation Files</p>
          <FileUploader taskId={taskId} />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-line">
          {isCompleted && (
            <button type="button" className="btn-secondary" onClick={cancelEditing} disabled={submitting}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn-primary" disabled={submitting || !canSubmitComplete(form)}>
            {submitting ? "Saving…" : isCompleted ? "Save Changes" : "Mark Submitted"}
          </button>
        </div>
      </form>
    </Card>
  );
}
