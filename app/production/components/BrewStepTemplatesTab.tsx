"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { Recipe } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { fetchJson, useRecipesQuery } from "../hooks/queries";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TemplateStep {
  id?: string;
  sort_order: number;
  activity: string;
  time_label: string;
  temp: string;
  temp_unit: string;
  amount: string;
  amount_unit: string;
  vsp: string;
}

interface BrewStepTemplate {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  brew_step_template_steps: TemplateStep[];
}

const EMPTY_STEP = (): TemplateStep => ({
  sort_order: 0, activity: "", time_label: "", temp: "", temp_unit: "F",
  amount: "", amount_unit: "", vsp: "",
});

// ─── Step Editor Row ──────────────────────────────────────────────────────────

function StepRow({
  step, index, onChange, onRemove,
}: {
  step: TemplateStep;
  index: number;
  onChange: (s: TemplateStep) => void;
  onRemove: () => void;
}) {
  function set(field: keyof TemplateStep, val: string) {
    onChange({ ...step, [field]: val });
  }
  return (
    <tr className={`border-b border-line/60 ${index % 2 !== 0 ? "bg-surface/20" : ""}`}>
      <td className="px-3 py-1.5">
        <input className="inp-sm w-full" placeholder="e.g. Mash in" value={step.activity}
          onChange={(e) => set("activity", e.target.value)} />
      </td>
      <td className="px-2 py-1.5 w-20">
        <input type="number" step="1" className="inp-sm text-right w-full" placeholder="0"
          value={step.time_label} onChange={(e) => set("time_label", e.target.value)} />
      </td>
      <td className="px-2 py-1.5 w-20">
        <input type="number" step="0.1" className="inp-sm text-right w-full" placeholder="152"
          value={step.temp} onChange={(e) => set("temp", e.target.value)} />
      </td>
      <td className="px-2 py-1.5 w-20">
        <input type="number" step="0.01" className="inp-sm text-right w-full" placeholder="0"
          value={step.amount} onChange={(e) => set("amount", e.target.value)} />
      </td>
      <td className="px-2 py-1.5 w-20">
        <input type="number" step="0.1" className="inp-sm text-right w-full" placeholder="0"
          value={step.vsp} onChange={(e) => set("vsp", e.target.value)} />
      </td>
      <td className="px-3 py-1.5 text-center">
        <button type="button" onClick={onRemove}
          className="btn-danger btn-xxs">×</button>
      </td>
    </tr>
  );
}

// ─── Template Modal ───────────────────────────────────────────────────────────

function TemplateModal({
  template,
  onClose,
  onSaved,
}: {
  template: BrewStepTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!template;
  const [name, setName] = useState(template?.name ?? "");
  const [desc, setDesc] = useState(template?.description ?? "");
  const [steps, setSteps] = useState<TemplateStep[]>(
    template?.brew_step_template_steps?.length
      ? template.brew_step_template_steps.map((s) => ({
          ...s,
          time_label: s.time_label ?? "",
          temp: s.temp != null ? String(s.temp) : "",
          temp_unit: s.temp_unit ?? "F",
          amount: s.amount != null ? String(s.amount) : "",
          amount_unit: s.amount_unit ?? "",
          vsp: s.vsp != null ? String(s.vsp) : "",
        }))
      : [EMPTY_STEP()]
  );
  const [submitting, setSubmitting] = useState(false);

  function addStep() {
    setSteps((ss) => [...ss, EMPTY_STEP()]);
  }
  function removeStep(i: number) {
    setSteps((ss) => ss.filter((_, idx) => idx !== i));
  }
  function updateStep(i: number, s: TemplateStep) {
    setSteps((ss) => ss.map((row, idx) => (idx === i ? s : row)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        description: desc.trim() || null,
        steps: steps
          .filter((s) => s.activity.trim())
          .map((s) => ({
            activity:   s.activity,
            time_label: s.time_label || null,
            temp:       s.temp   !== "" ? s.temp   : null,
            temp_unit:  s.temp_unit || "F",
            amount:     s.amount !== "" ? s.amount : null,
            amount_unit: s.amount_unit || null,
            vsp:        s.vsp    !== "" ? s.vsp    : null,
          })),
      };

      const url    = isEdit ? `/api/production/brew-step-templates/${template!.id}` : "/api/production/brew-step-templates";
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onSaved();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit Template" : "New Brew Step Template"} onClose={onClose} extraWide>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Template Name" required>
            <input className="inp" required value={name} placeholder="e.g. Standard Ale Process"
              onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <input className="inp" value={desc} placeholder="Optional"
              onChange={(e) => setDesc(e.target.value)} />
          </Field>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-secondary">Steps</label>
            <button type="button" onClick={addStep}
              className="btn-secondary">+ Add step</button>
          </div>
          <div className="rounded border border-line overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="border-b border-line bg-surface/50">
                  <th className="px-3 py-2 text-xs font-medium text-muted text-left">Activity</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted text-right w-20">Time (min)</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted text-right w-20">Temp (°F)</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted text-right w-20">Amount</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted text-right w-20">VSP</th>
                  <th className="px-3 py-2 w-6"></th>
                </tr>
              </thead>
              <tbody>
                {(steps as TemplateStep[]).map((s: TemplateStep, i: number) => (
                  <StepRow key={i} step={s} index={i}
                    onChange={(ns) => updateStep(i, ns)}
                    onRemove={() => removeStep(i)} />
                ))}
              </tbody>
            </table>
          </div>
          {steps.filter((s) => s.activity.trim()).length === 0 && (
            <p className="text-xs text-faint mt-1">At least one step required.</p>
          )}
        </div>

        <ModalActions submitting={submitting} onCancel={onClose}
          label={isEdit ? "Save Template" : "Create Template"} />
      </form>
    </Modal>
  );
}

// ─── Apply to Recipe Modal ────────────────────────────────────────────────────

function ApplyModal({
  template,
  recipes,
  onClose,
  onApplied,
}: {
  template: BrewStepTemplate;
  recipes: Recipe[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const [recipeId, setRecipeId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    if (!recipeId) return;
    const recipe = recipes.find((r) => r.id === recipeId);
    const hasSteps = (recipe?.recipe_brew_activity_templates?.length ?? 0) > 0;
    if (hasSteps && !confirm(`Replace existing brew steps on "${recipe?.beer_name}" with "${template.name}"?`)) return;

    setSubmitting(true);
    try {
      // Delete existing brew activity templates for the recipe
      const existingIds = recipe?.recipe_brew_activity_templates?.map((t) => t.id) ?? [];
      await Promise.all(
        existingIds.map((tid) =>
          fetch(`/api/production/brew-activities?id=${tid}`, { method: "DELETE" })
        )
      );

      // Insert new steps from template
      for (let i = 0; i < template.brew_step_template_steps.length; i++) {
        const s = template.brew_step_template_steps[i];
        await fetch("/api/production/brew-activities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipe_id:  recipeId,
            sort_order: i,
            activity:   s.activity,
            time_label: s.time_label ?? null,
            temp:       s.temp   != null && s.temp   !== "" ? Number(s.temp)   : null,
            amount:     s.amount != null && s.amount !== "" ? Number(s.amount) : null,
            vsp:        s.vsp    != null && s.vsp    !== "" ? Number(s.vsp)    : null,
          }),
        });
      }

      onApplied();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Apply "${template.name}"`} onClose={onClose}>
      <p className="text-xs text-muted mb-4">
        This will replace the brew steps on the selected recipe with the {template.brew_step_template_steps.length} steps from this template.
      </p>
      <form onSubmit={handleApply} className="space-y-4">
        <Field label="Recipe" required>
          <select className="inp" value={recipeId} required onChange={(e) => setRecipeId(e.target.value)}>
            <option value="">— select recipe —</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>{r.beer_name}</option>
            ))}
          </select>
        </Field>
        <ModalActions submitting={submitting} onCancel={onClose} label="Apply to Recipe" />
      </form>
    </Modal>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BrewStepTemplatesTab() {
  const qc = useQueryClient();
  const { data: templates = [], isLoading } = useQuery({
    queryKey: queryKeys.production.brewStepTemplates(),
    queryFn:  () => fetchJson<BrewStepTemplate[]>("/api/production/brew-step-templates"),
  });
  const { data: recipes = [] } = useRecipesQuery();

  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.production.brewStepTemplates() });

  const [editingTemplate, setEditingTemplate] = useState<BrewStepTemplate | null | "new">(null);
  const [applyingTemplate, setApplyingTemplate] = useState<BrewStepTemplate | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function handleDelete(t: BrewStepTemplate) {
    if (!confirm(`Delete template "${t.name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/production/brew-step-templates/${t.id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("Delete failed");
      return;
    }
    refresh();
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted">Reusable step sequences — apply to any recipe to populate its brew activity log</p>
        <button onClick={() => setEditingTemplate("new")} className="btn-primary">+ New Template</button>
      </div>

      {isLoading ? (
        <p className="text-faint text-sm py-10 text-center">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="text-faint text-sm py-4">No templates yet. Create one to get started.</p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => {
            const isOpen = expanded === t.id;
            return (
              <div key={t.id} className="rounded-lg border border-line overflow-hidden">
                <div
                  className="px-4 py-3 cursor-pointer hover:bg-surface/40 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : t.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-sm font-medium text-primary">{t.name}</span>
                      <span className="text-xs text-faint shrink-0">
                        {t.brew_step_template_steps.length} step{t.brew_step_template_steps.length !== 1 ? "s" : ""}
                      </span>
                      {t.description && (
                        <span className="text-xs text-muted truncate hidden sm:block">{t.description}</span>
                      )}
                    </div>
                    <span className="text-faint text-xs shrink-0">{isOpen ? "▲" : "▼"}</span>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-line">
                    {t.brew_step_template_steps.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[480px]">
                          <thead>
                            <tr className="border-b border-line bg-surface/50 text-left">
                              <th className="px-4 py-2 text-xs font-medium text-muted">#</th>
                              <th className="px-4 py-2 text-xs font-medium text-muted">Activity</th>
                              <th className="px-4 py-2 text-xs font-medium text-muted text-right">Time (min)</th>
                              <th className="px-4 py-2 text-xs font-medium text-muted text-right">Temp</th>
                              <th className="px-4 py-2 text-xs font-medium text-muted text-right">Amount</th>
                              <th className="px-4 py-2 text-xs font-medium text-muted text-right">VSP</th>
                            </tr>
                          </thead>
                          <tbody>
                            {t.brew_step_template_steps.map((s, i) => (
                              <tr key={i} className={`border-b border-line/40 ${i % 2 !== 0 ? "bg-surface/20" : ""}`}>
                                <td className="px-4 py-1.5 text-xs text-faint">{i + 1}</td>
                                <td className="px-4 py-1.5 text-body">{s.activity}</td>
                                <td className="px-4 py-1.5 text-right text-xs text-muted tabular-nums">
                                  {s.time_label || "—"}
                                </td>
                                <td className="px-4 py-1.5 text-right text-xs text-muted tabular-nums">
                                  {s.temp != null ? `${s.temp}°${s.temp_unit ?? "F"}` : "—"}
                                </td>
                                <td className="px-4 py-1.5 text-right text-xs text-muted tabular-nums">
                                  {s.amount != null ? `${s.amount}${s.amount_unit ? ` ${s.amount_unit}` : ""}` : "—"}
                                </td>
                                <td className="px-4 py-1.5 text-right text-xs text-muted tabular-nums">
                                  {s.vsp != null ? String(s.vsp) : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="px-4 py-3 text-xs text-faint">No steps defined.</p>
                    )}

                    <div className="flex gap-3 px-4 py-2.5 border-t border-line bg-surface/30">
                      <button onClick={() => setEditingTemplate(t)}
                        className="btn-secondary">
                        Edit
                      </button>
                      <button onClick={() => setApplyingTemplate(t)}
                        className="btn-primary">
                        Apply to Recipe
                      </button>
                      <button onClick={() => handleDelete(t)}
                        className="btn-danger">
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editingTemplate !== null && (
        <TemplateModal
          template={editingTemplate === "new" ? null : editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSaved={() => { setEditingTemplate(null); refresh(); }}
        />
      )}

      {applyingTemplate && (
        <ApplyModal
          template={applyingTemplate}
          recipes={recipes}
          onClose={() => setApplyingTemplate(null)}
          onApplied={() => {
            setApplyingTemplate(null);
            qc.invalidateQueries({ queryKey: queryKeys.production.recipes() });
          }}
        />
      )}
    </>
  );
}
