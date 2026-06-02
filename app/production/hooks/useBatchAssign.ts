"use client";

import React, { useState } from "react";
import { BrewBatch } from "../types";

export function useBatchAssign(unassignedBatches: BrewBatch[], onRefresh: () => Promise<void>) {
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignTankId, setAssignTankId]       = useState<string | null>(null);
  const [assignBatchId, setAssignBatchId]     = useState("");
  const [assignNotes, setAssignNotes]         = useState("");
  const [assignSubmitting, setAssignSubmitting] = useState(false);

  function openAssign(tankId: string) {
    setAssignTankId(tankId);
    setAssignBatchId(unassignedBatches[0]?.id ?? "");
    setAssignNotes("");
    setShowAssignModal(true);
  }

  async function handleAssignSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!assignBatchId || !assignTankId) return;
    setAssignSubmitting(true);
    try {
      const res = await fetch("/api/production/tank-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_id: assignBatchId, tank_id: assignTankId, notes: assignNotes || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowAssignModal(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setAssignSubmitting(false);
    }
  }

  async function handleRelease(assignmentId: string) {
    if (!confirm("Release this batch from the tank?")) return;
    await fetch(`/api/production/tank-assignments/${assignmentId}`, { method: "PATCH" });
    await onRefresh();
  }

  return {
    showAssignModal, setShowAssignModal,
    assignTankId, assignBatchId, setAssignBatchId,
    assignNotes, setAssignNotes,
    assignSubmitting,
    openAssign, handleAssignSubmit, handleRelease,
  };
}
