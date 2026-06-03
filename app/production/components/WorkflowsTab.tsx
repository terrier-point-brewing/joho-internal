"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Equipment, WorkflowTemplate, WorkflowTemplateStep, BatchWorkflowStep, BrewBatch } from "../types";
import { Modal, Field, ModalActions } from "./shared";


// ─── Helpers ──────────────────────────────────────────────────────────────────

const EQ_TYPE_LABELS: Record<string, string> = {
  fermenter: "FV", brite: "Brite", unitank: "UT",
  serving: "Serv", brewhouse: "BH", cold_storage: "Cold",
};

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

// ─── Template step form line ──────────────────────────────────────────────────

interface TmplStepLine {
  equipment_id: string;
  duration_days: string;
  notes: string;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function WorkflowsTab({
  equipment,
  batches,
  subtab = "planner",
}: {
  equipment: Equipment[];
  batches: BrewBatch[];
  subtab?: "planner" | "templates";
}) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [batchSteps, setBatchSteps] = useState<BatchWorkflowStep[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string>("");

  const loadTemplates = useCallback(async () => {
    const r = await fetch("/api/production/workflow-templates");
    if (r.ok) setTemplates(await r.json());
  }, []);

  const loadBatchSteps = useCallback(async (batchId: string) => {
    if (!batchId) { setBatchSteps([]); return; }
    const r = await fetch(`/api/production/batch-workflows?batch_id=${batchId}`);
    if (r.ok) setBatchSteps(await r.json());
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);
  useEffect(() => { loadBatchSteps(selectedBatchId); }, [selectedBatchId, loadBatchSteps]);

  const activeBatches = batches.filter((b) => b.status !== "archived");

  if (subtab === "templates") {
    return (
      <TemplatesSection
        templates={templates}
        equipment={equipment}
        onRefresh={loadTemplates}
      />
    );
  }

  return (
    <BatchWorkflowsSection
      batches={activeBatches}
      equipment={equipment}
      templates={templates}
      batchSteps={batchSteps}
      selectedBatchId={selectedBatchId}
      onSelectBatch={(id) => setSelectedBatchId(id)}
      onRefresh={() => loadBatchSteps(selectedBatchId)}
    />
  );
}

// ─── Templates section ────────────────────────────────────────────────────────

function TemplatesSection({
  templates,
  equipment,
  onRefresh,
}: {
  templates: WorkflowTemplate[];
  equipment: Equipment[];
  onRefresh: () => Promise<void>;
}) {
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "" });
  const [steps, setSteps] = useState<TmplStepLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  function openNew() {
    setForm({ name: "", description: "" });
    setSteps(equipment.length ? [{ equipment_id: equipment[0].id, duration_days: "", notes: "" }] : []);
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(t: WorkflowTemplate) {
    setForm({ name: t.name, description: t.description ?? "" });
    const sorted = [...t.workflow_template_steps].sort((a, b) => a.step_order - b.step_order);
    setSteps(sorted.map((s) => ({
      equipment_id: s.equipment_id,
      duration_days: s.duration_days != null ? String(s.duration_days) : "",
      notes: s.notes ?? "",
    })));
    setEditingId(t.id);
    setShowModal(true);
  }

  function addStep() {
    if (!equipment.length) return;
    setSteps((s) => [...s, { equipment_id: equipment[0].id, duration_days: "", notes: "" }]);
  }

  function moveStep(i: number, dir: -1 | 1) {
    setSteps((s) => {
      const next = [...s];
      const j = i + dir;
      if (j < 0 || j >= next.length) return s;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        name: form.name,
        description: form.description || null,
        steps: steps.map((s) => ({
          equipment_id: s.equipment_id,
          duration_days: s.duration_days ? parseInt(s.duration_days) : null,
          notes: s.notes || null,
        })),
      };
      const res = editingId
        ? await fetch(`/api/production/workflow-templates/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/workflow-templates",              { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowModal(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete template "${name}"?`)) return;
    await fetch(`/api/production/workflow-templates/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  // Calculate total days for a template
  function totalDays(t: WorkflowTemplate): number {
    return t.workflow_template_steps.reduce((sum, s) => sum + (s.duration_days ?? 0), 0);
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-medium text-zinc-100">Workflow Templates</h3>
          <p className="text-sm text-zinc-500 mt-0.5">Reusable equipment sequences — apply to batches with a start date</p>
        </div>
        <button onClick={openNew} className="btn-amber">+ New Template</button>
      </div>

      {templates.length === 0 ? (
        <p className="text-zinc-600 text-sm">No templates yet. Create one to define a standard route through your equipment.</p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => {
            const sorted = [...t.workflow_template_steps].sort((a, b) => a.step_order - b.step_order);
            const days = totalDays(t);
            const isOpen = expanded === t.id;
            return (
              <div key={t.id} className="rounded-lg border border-zinc-800 overflow-hidden">
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-900/40 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : t.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-medium text-zinc-100">{t.name}</span>
                    <span className="text-xs text-zinc-600">{sorted.length} steps</span>
                    {days > 0 && <span className="text-xs text-zinc-600">{days} days total</span>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    {/* Step flow summary */}
                    <div className="hidden sm:flex items-center gap-1">
                      {sorted.map((s, i) => (
                        <React.Fragment key={s.id}>
                          <span className="text-xs text-zinc-500 bg-zinc-800 px-1.5 py-px rounded">
                            {EQ_TYPE_LABELS[s.equipment.type] ?? "?"} {s.equipment.name}
                          </span>
                          {i < sorted.length - 1 && <span className="text-zinc-700 text-xs">→</span>}
                        </React.Fragment>
                      ))}
                    </div>
                    <span className="text-zinc-600 text-xs">{isOpen ? "▲" : "▼"}</span>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-zinc-800">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                          <th className="px-4 py-2 text-xs font-medium text-zinc-500 w-8">#</th>
                          <th className="px-4 py-2 text-xs font-medium text-zinc-500">Equipment</th>
                          <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Duration</th>
                          <th className="px-4 py-2 text-xs font-medium text-zinc-500">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((s, i) => (
                          <tr key={s.id} className={`border-b border-zinc-800/40 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                            <td className="px-4 py-2 text-zinc-600 text-xs">{i + 1}</td>
                            <td className="px-4 py-2 text-zinc-200">{s.equipment.name}
                              <span className="ml-1.5 text-xs text-zinc-500">{EQ_TYPE_LABELS[s.equipment.type]}</span>
                            </td>
                            <td className="px-4 py-2 text-right text-zinc-400 text-xs">
                              {s.duration_days ? `${s.duration_days}d` : "—"}
                            </td>
                            <td className="px-4 py-2 text-zinc-500 text-xs">{s.notes ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {t.description && (
                      <p className="px-4 py-2 text-xs text-zinc-500 italic border-t border-zinc-800">{t.description}</p>
                    )}
                    <div className="flex gap-3 px-4 py-2 border-t border-zinc-800 bg-zinc-900/30">
                      <button onClick={() => openEdit(t)} className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors">Edit</button>
                      <button onClick={() => handleDelete(t.id, t.name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Template" : "New Template"} onClose={() => setShowModal(false)} wide>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Template Name" required>
                <input className="inp" value={form.name} required
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="Description">
                <input className="inp" placeholder="e.g. Standard ale route"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              </Field>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-zinc-400">Steps <span className="text-zinc-600">(in order)</span></label>
                <button type="button" onClick={addStep} className="text-xs text-amber-500 hover:text-amber-400 transition-colors">+ Add step</button>
              </div>
              {equipment.length === 0 && <p className="text-xs text-zinc-600">Add equipment in Brew Status first.</p>}
              {steps.length > 0 && (
                <div className="rounded border border-zinc-800 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-800 bg-zinc-900/50">
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-left w-8">#</th>
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-left">Equipment</th>
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-left w-24">Duration (days)</th>
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-left">Notes</th>
                        <th className="px-3 py-2 w-16"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {steps.map((s, i) => (
                        <tr key={i} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                          <td className="px-3 py-1.5 text-zinc-500 text-xs">{i + 1}</td>
                          <td className="px-3 py-1.5">
                            <select className="inp" value={s.equipment_id}
                              onChange={(e) => setSteps((ls) => ls.map((l, idx) => idx === i ? { ...l, equipment_id: e.target.value } : l))}>
                              {equipment.map((eq) => (
                                <option key={eq.id} value={eq.id}>{eq.name} ({EQ_TYPE_LABELS[eq.type] ?? eq.type})</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-1.5">
                            <input type="number" min="0" className="inp text-right" placeholder="—"
                              value={s.duration_days}
                              onChange={(e) => setSteps((ls) => ls.map((l, idx) => idx === i ? { ...l, duration_days: e.target.value } : l))} />
                          </td>
                          <td className="px-3 py-1.5">
                            <input className="inp" placeholder="Optional…" value={s.notes}
                              onChange={(e) => setSteps((ls) => ls.map((l, idx) => idx === i ? { ...l, notes: e.target.value } : l))} />
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex gap-1 justify-end">
                              <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0} className="text-zinc-600 hover:text-zinc-300 disabled:opacity-20 text-xs">↑</button>
                              <button type="button" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} className="text-zinc-600 hover:text-zinc-300 disabled:opacity-20 text-xs">↓</button>
                              <button type="button" onClick={() => setSteps((s) => s.filter((_, idx) => idx !== i))} className="text-zinc-600 hover:text-red-400 text-xs">×</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)}
              label={editingId ? "Save Template" : "Create Template"} />
          </form>
        </Modal>
      )}
    </>
  );
}

// ─── Batch workflows section ──────────────────────────────────────────────────

function BatchWorkflowsSection({
  batches,
  equipment,
  templates,
  batchSteps,
  selectedBatchId,
  onSelectBatch,
  onRefresh,
}: {
  batches: BrewBatch[];
  equipment: Equipment[];
  templates: WorkflowTemplate[];
  batchSteps: BatchWorkflowStep[];
  selectedBatchId: string;
  onSelectBatch: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [showAddStep, setShowAddStep] = useState(false);
  const [addForm, setAddForm] = useState({ equipment_id: "", scheduled_date: "", notes: "" });
  const [addSubmitting, setAddSubmitting] = useState(false);

  const [showApplyTmpl, setShowApplyTmpl] = useState(false);
  const [tmplForm, setTmplForm] = useState({ template_id: "", start_date: new Date().toISOString().slice(0, 10) });
  const [tmplSubmitting, setTmplSubmitting] = useState(false);

  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editStepDate, setEditStepDate] = useState("");

  const sorted = [...batchSteps].sort((a, b) => a.step_order - b.step_order);
  const selectedBatch = batches.find((b) => b.id === selectedBatchId);

  // Compute preview dates for apply-template modal
  const previewSteps = (() => {
    const tmpl = templates.find((t) => t.id === tmplForm.template_id);
    if (!tmpl || !tmplForm.start_date) return [];
    const tmplSorted = [...tmpl.workflow_template_steps].sort((a, b) => a.step_order - b.step_order);
    let d = new Date(tmplForm.start_date + "T00:00:00");
    return tmplSorted.map((s) => {
      const date = d.toISOString().slice(0, 10);
      if (s.duration_days) d = addDays(d, s.duration_days);
      return { equipment: s.equipment.name, date, duration: s.duration_days };
    });
  })();

  async function handleAddStep(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatchId) return;
    setAddSubmitting(true);
    try {
      const res = await fetch("/api/production/batch-workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id: selectedBatchId,
          step: {
            equipment_id: addForm.equipment_id,
            scheduled_date: addForm.scheduled_date || null,
            notes: addForm.notes || null,
          },
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowAddStep(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleApplyTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatchId || !tmplForm.template_id) return;
    if (!confirm("This will replace all existing workflow steps for this batch. Continue?")) return;
    setTmplSubmitting(true);
    try {
      const res = await fetch("/api/production/batch-workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id: selectedBatchId,
          template_id: tmplForm.template_id,
          start_date: tmplForm.start_date,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowApplyTmpl(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setTmplSubmitting(false);
    }
  }

  async function toggleComplete(step: BatchWorkflowStep) {
    await fetch(`/api/production/batch-workflows/${step.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complete: !step.completed_at }),
    });
    await onRefresh();
  }

  async function updateDate(stepId: string, date: string) {
    await fetch(`/api/production/batch-workflows/${stepId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduled_date: date || null }),
    });
    setEditingStepId(null);
    await onRefresh();
  }

  async function deleteStep(id: string) {
    if (!confirm("Remove this workflow step?")) return;
    await fetch(`/api/production/batch-workflows/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  return (
    <>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-medium text-zinc-100">Batch Workflows</h3>
          <p className="text-sm text-zinc-500 mt-0.5">Schedule a batch's journey through equipment</p>
        </div>
      </div>

      {/* Batch selector */}
      <div className="flex items-center gap-3 mb-6">
        <label className="text-sm text-zinc-400 shrink-0">Select batch:</label>
        <select
          className="inp max-w-xs"
          value={selectedBatchId}
          onChange={(e) => onSelectBatch(e.target.value)}
        >
          <option value="">— choose a batch —</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.batch_number ?? "?"} · {b.beer_name}
            </option>
          ))}
        </select>
        {selectedBatch && (
          <span className="text-xs text-zinc-500">{selectedBatch.status}</span>
        )}
      </div>

      {selectedBatchId && (
        <>
          {/* Actions */}
          <div className="flex gap-2 mb-4">
            <button onClick={() => setShowAddStep(true)} className="btn-amber text-sm">+ Add Step</button>
            {templates.length > 0 && (
              <button
                onClick={() => { setTmplForm({ template_id: templates[0].id, start_date: new Date().toISOString().slice(0, 10) }); setShowApplyTmpl(true); }}
                className="px-3 py-1.5 text-sm border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-zinc-100 rounded transition-colors"
              >
                Apply Template…
              </button>
            )}
          </div>

          {/* Workflow timeline */}
          {sorted.length === 0 ? (
            <p className="text-zinc-600 text-sm">No workflow steps yet. Add steps or apply a template.</p>
          ) : (
            <div className="relative">
              {/* Connecting line */}
              <div className="absolute left-[19px] top-4 bottom-4 w-px bg-zinc-800 z-0" />

              <div className="space-y-0">
                {sorted.map((step, i) => {
                  const done = !!step.completed_at;
                  const eq = equipment.find((e) => e.id === step.equipment_id);
                  const isEditingDate = editingStepId === step.id;
                  const isLast = i === sorted.length - 1;

                  // Calculate duration to next step
                  const nextStep = sorted[i + 1];
                  let daysToNext: number | null = null;
                  if (nextStep?.scheduled_date && step.scheduled_date) {
                    daysToNext = Math.round(
                      (new Date(nextStep.scheduled_date + "T00:00:00").getTime() -
                       new Date(step.scheduled_date   + "T00:00:00").getTime()) / 86400000
                    );
                  }

                  return (
                    <div key={step.id} className="flex gap-4 relative z-10">
                      {/* Timeline dot */}
                      <div className="flex flex-col items-center shrink-0 w-10">
                        <button
                          onClick={() => toggleComplete(step)}
                          title={done ? "Mark incomplete" : "Mark complete"}
                          className={`w-5 h-5 rounded-full border-2 mt-3 shrink-0 transition-colors ${
                            done
                              ? "bg-green-500 border-green-500"
                              : "bg-zinc-900 border-zinc-600 hover:border-amber-500"
                          }`}
                        />
                        {!isLast && daysToNext != null && (
                          <span className="text-zinc-700 text-xs mt-1">{daysToNext}d</span>
                        )}
                      </div>

                      {/* Step card */}
                      <div className={`flex-1 rounded-lg border mb-3 overflow-hidden ${done ? "border-zinc-800 opacity-70" : "border-zinc-700"}`}>
                        <div className={`flex items-center justify-between px-3 py-2 ${done ? "bg-zinc-900/30" : "bg-zinc-900/60"}`}>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-zinc-500 w-5">{i + 1}</span>
                            <span className={`font-medium text-sm ${done ? "line-through text-zinc-500" : "text-zinc-100"}`}>
                              {step.equipment.name}
                            </span>
                            <span className="text-xs text-zinc-600">{EQ_TYPE_LABELS[step.equipment.type] ?? step.equipment.type}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            {/* Date */}
                            {isEditingDate ? (
                              <div className="flex items-center gap-1">
                                <input
                                  type="date"
                                  className="inp w-36 text-xs"
                                  defaultValue={step.scheduled_date ?? ""}
                                  onBlur={(e) => updateDate(step.id, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") updateDate(step.id, (e.target as HTMLInputElement).value);
                                    if (e.key === "Escape") setEditingStepId(null);
                                  }}
                                  autoFocus
                                />
                              </div>
                            ) : (
                              <button
                                onClick={() => setEditingStepId(step.id)}
                                className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                                title="Click to edit date"
                              >
                                {step.scheduled_date ? fmtDate(step.scheduled_date) : <span className="text-zinc-600">No date</span>}
                              </button>
                            )}
                            {done && step.completed_at && (
                              <span className="text-xs text-green-600">
                                ✓ {new Date(step.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              </span>
                            )}
                            <button onClick={() => deleteStep(step.id)} className="text-xs text-zinc-700 hover:text-red-400 transition-colors">×</button>
                          </div>
                        </div>
                        {step.notes && (
                          <div className="px-3 py-1.5 border-t border-zinc-800/60">
                            <p className="text-xs text-zinc-500 italic">{step.notes}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {!selectedBatchId && batches.length === 0 && (
        <p className="text-zinc-600 text-sm">No active batches. Create a batch in the Batch Log tab first.</p>
      )}

      {/* Add step modal */}
      {showAddStep && (
        <Modal title="Add Workflow Step" onClose={() => setShowAddStep(false)}>
          <form onSubmit={handleAddStep} className="space-y-4">
            <Field label="Equipment" required>
              <select className="inp" value={addForm.equipment_id} required
                onChange={(e) => setAddForm((f) => ({ ...f, equipment_id: e.target.value }))}>
                <option value="">— select equipment —</option>
                {equipment.map((eq) => (
                  <option key={eq.id} value={eq.id}>{eq.name} ({EQ_TYPE_LABELS[eq.type] ?? eq.type})</option>
                ))}
              </select>
            </Field>
            <Field label="Scheduled Date">
              <input type="date" className="inp" value={addForm.scheduled_date}
                onChange={(e) => setAddForm((f) => ({ ...f, scheduled_date: e.target.value }))} />
            </Field>
            <Field label="Notes">
              <input className="inp" value={addForm.notes}
                onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>
            <ModalActions submitting={addSubmitting} onCancel={() => setShowAddStep(false)} label="Add Step" />
          </form>
        </Modal>
      )}

      {/* Apply template modal */}
      {showApplyTmpl && (
        <Modal title="Apply Workflow Template" onClose={() => setShowApplyTmpl(false)}>
          <form onSubmit={handleApplyTemplate} className="space-y-4">
            <Field label="Template" required>
              <select className="inp" value={tmplForm.template_id} required
                onChange={(e) => setTmplForm((f) => ({ ...f, template_id: e.target.value }))}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Start Date" required hint="(date batch enters first equipment)">
              <input type="date" className="inp" value={tmplForm.start_date} required
                onChange={(e) => setTmplForm((f) => ({ ...f, start_date: e.target.value }))} />
            </Field>

            {/* Preview */}
            {previewSteps.length > 0 && (
              <div className="rounded border border-zinc-800 overflow-hidden">
                <div className="px-3 py-2 bg-zinc-900/50 border-b border-zinc-800">
                  <p className="text-xs text-zinc-500 font-medium">Schedule preview</p>
                </div>
                <div className="divide-y divide-zinc-800/60">
                  {previewSteps.map((s, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-zinc-600">{i + 1}.</span>
                        <span className="text-sm text-zinc-200">{s.equipment}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-zinc-400">{fmtDate(s.date)}</span>
                        {s.duration && <span className="text-xs text-zinc-600">{s.duration}d</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-amber-600">
              ⚠ This will replace all existing steps for this batch.
            </p>
            <ModalActions submitting={tmplSubmitting} onCancel={() => setShowApplyTmpl(false)} label="Apply Template" />
          </form>
        </Modal>
      )}
    </>
  );
}
