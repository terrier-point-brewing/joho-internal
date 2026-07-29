"use client";

import React, { useState } from "react";
import { BrewBatch } from "../types";
import type { IngredientShortfall } from "@/lib/production/commitments";

export function useBatchAssign(unassignedBatches: BrewBatch[], onRefresh: () => Promise<void>) {
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignTankId, setAssignTankId]       = useState<string | null>(null);
  const [assignBatchId, setAssignBatchId]     = useState("");
  const [assignNotes, setAssignNotes]         = useState("");
  const [assignSubmitting, setAssignSubmitting] = useState(false);
  // Yeast re-pitch: the batch reuses yeast cropped from an earlier one, so the
  // recipe's yeast is not consumed. Affects yeast only.
  const [yeastRepitch, setYeastRepitch]         = useState(false);
  const [yeastRepitchNote, setYeastRepitchNote] = useState("");
  // Shortfalls returned by a 422, so the caller can open the detail modal
  // instead of dumping ingredient names into an alert().
  const [assignShortfalls, setAssignShortfalls] = useState<IngredientShortfall[] | null>(null);

  function openAssign(tankId: string) {
    setAssignTankId(tankId);
    setAssignBatchId(unassignedBatches[0]?.id ?? "");
    setAssignNotes("");
    setYeastRepitch(false);
    setYeastRepitchNote("");
    setAssignShortfalls(null);
    setShowAssignModal(true);
  }

  async function handleAssignSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!assignBatchId || !assignTankId) return;
    setAssignSubmitting(true);
    setAssignShortfalls(null);
    try {
      const res = await fetch("/api/production/tank-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id: assignBatchId,
          tank_id: assignTankId,
          notes: assignNotes || null,
          yeast_repitch: yeastRepitch,
          yeast_repitch_note: yeastRepitch ? (yeastRepitchNote || null) : null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // An ingredient block carries the full shortfall detail — surface it in
        // the modal rather than an alert, so the brewer can see what's missing.
        if (res.status === 422 && Array.isArray(body.shortfalls) && body.shortfalls.length > 0) {
          setAssignShortfalls(body.shortfalls as IngredientShortfall[]);
          return;
        }
        throw new Error(body.error ?? "Error");
      }
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
    yeastRepitch, setYeastRepitch,
    yeastRepitchNote, setYeastRepitchNote,
    assignShortfalls, setAssignShortfalls,
    openAssign, handleAssignSubmit, handleRelease,
  };
}
