"use client";

import React, { useState } from "react";
import { Equipment, EquipmentType, UNCONSTRAINED_EQUIPMENT_TYPES } from "../types";
import { EQ } from "../equipmentMeta";

const TANK_EMPTY = {
  name: "", type: "fermenter" as EquipmentType, capacity_bbl: "", notes: "", grid_width: "2", grid_height: "4",
};

export type TankForm = typeof TANK_EMPTY;

export function useEquipmentCrud(onRefresh: () => Promise<void>) {
  const [showEqModal, setShowEqModal]   = useState(false);
  const [eqForm, setEqForm]             = useState<TankForm>(TANK_EMPTY);
  const [editingId, setEditingId]       = useState<string | null>(null);
  const [eqSubmitting, setEqSubmitting] = useState(false);

  function openNew() {
    setEqForm(TANK_EMPTY);
    setEditingId(null);
    setShowEqModal(true);
  }

  function openEdit(t: Equipment) {
    setEqForm({
      name:         t.name,
      type:         t.type,
      capacity_bbl: t.capacity_bbl != null ? String(t.capacity_bbl) : "",
      notes:        t.notes ?? "",
      grid_width:   String(t.grid_width),
      grid_height:  String(t.grid_height),
    });
    setEditingId(t.id);
    setShowEqModal(true);
  }

  async function handleEqSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setEqSubmitting(true);
    const isUnconstrained = UNCONSTRAINED_EQUIPMENT_TYPES.includes(eqForm.type);
    try {
      const payload = {
        name:         eqForm.name,
        type:         eqForm.type,
        capacity_bbl: (!isUnconstrained && eqForm.capacity_bbl) ? parseFloat(eqForm.capacity_bbl) : null,
        notes:        eqForm.notes || null,
        grid_width:   parseInt(eqForm.grid_width)  || EQ[eqForm.type]!.defaultW,
        grid_height:  parseInt(eqForm.grid_height) || EQ[eqForm.type]!.defaultH,
      };
      const res = editingId
        ? await fetch(`/api/production/equipment/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/equipment",              { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowEqModal(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setEqSubmitting(false);
    }
  }

  async function handleDeleteEq(id: string, name: string) {
    if (!confirm(`Delete "${name}"?`)) return;
    await fetch(`/api/production/equipment/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  return {
    showEqModal, setShowEqModal,
    eqForm, setEqForm,
    editingId,
    eqSubmitting,
    openNew, openEdit, handleEqSubmit, handleDeleteEq,
  };
}
