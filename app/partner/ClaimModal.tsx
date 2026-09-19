"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import { bbl, shortDate, type ClaimableBatch } from "./types";

export default function ClaimModal({ batch, onClose, onSubmitted }: { batch: ClaimableBatch; onClose: () => void; onSubmitted: () => void }) {
  const [volume, setVolume] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const amount = Number(volume);
  const tooMuch = amount > batch.claimable_bbl;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const form = new FormData();
    form.set("payload", JSON.stringify({ kind: "claim", batch_id: batch.batch_id, volume_bbl: amount, notes }));
    const res = await fetch("/api/partner/requests", { method: "POST", body: form });
    setSaving(false);
    if (res.ok) return onSubmitted();
    setError((await res.json().catch(() => ({}))).error ?? "Could not send the claim.");
  }

  return (
    <Modal title={`Claim ${batch.beer_name}`} onClose={onClose}>
      {error && <Banner className="mb-4">{error}</Banner>}
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          {bbl(batch.claimable_bbl)} available: <span className="text-success">{bbl(batch.ready_now_bbl)} packaged and ready now</span>,{" "}
          <span className="text-info">{bbl(batch.in_tank_bbl)} still in tank</span>
          {batch.in_tank_bbl > 0.005 ? (batch.ready_by ? `, expected around ${shortDate(batch.ready_by)}` : ", date to be confirmed") : ""}.
        </p>
        <Field label="How much do you want?" required hint="in bbl">
          <input
            type="number" inputMode="decimal" required min={0.01} step={0.01} max={batch.claimable_bbl}
            value={volume} onChange={(e) => setVolume(e.target.value)} autoFocus className="inp w-full"
          />
        </Field>
        {tooMuch && <p className="text-xs text-danger">Only {bbl(batch.claimable_bbl)} is available.</p>}
        {!tooMuch && amount > batch.ready_now_bbl + 0.005 && (
          <p className="text-xs text-info">
            {batch.ready_now_bbl > 0.005
              ? `${bbl(batch.ready_now_bbl)} of this can ship now; the other ${bbl(amount - batch.ready_now_bbl)} comes once the rest is packaged.`
              : "None of this is packaged yet — it ships once the beer is packaged, and the final amount may come in a little under the estimate."}
          </p>
        )}
        <Field label="Notes" hint="packaging, timing, anything we should know">
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className="inp w-full" />
        </Field>
        <p className="text-xs text-muted">The beer is held for you once we approve the claim, not before.</p>
        <ModalActions submitting={saving} onCancel={onClose} label="Send claim" disabled={!(amount > 0) || tooMuch} />
      </form>
    </Modal>
  );
}
