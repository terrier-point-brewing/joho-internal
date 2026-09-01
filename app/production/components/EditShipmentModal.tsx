"use client";

import { useMemo, useState } from "react";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import { useContractPartnersQuery } from "../hooks/queries";
import { allowedTargetChannels, type ShipmentEditRow } from "@/lib/production/shipmentEdit";

const CHANNEL_LABELS: Record<string, string> = {
  taproom: "Taproom",
  distribution: "Distribution",
  contract_brewing: "Contract",
  wholesale: "Wholesale",
};

interface EditShipmentModalProps {
  shipmentId: string;
  rows: ShipmentEditRow[];
  currentRecipientId: string | null;
  currentNotes: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Edit a booked shipment's channel, recipient, and notes.
 *
 * The channel options come from `allowedTargetChannels` — the same module the
 * PATCH route enforces with — so this form cannot offer an edit the API rejects.
 * Guard messages from the API are surfaced verbatim rather than paraphrased.
 */
export default function EditShipmentModal({
  shipmentId,
  rows,
  currentRecipientId,
  currentNotes,
  onClose,
  onSaved,
}: EditShipmentModalProps) {
  const { data: partners = [] } = useContractPartnersQuery();

  const currentChannels = useMemo(() => [...new Set(rows.map((r) => r.channel))], [rows]);
  const targets = useMemo(() => allowedTargetChannels(currentChannels), [currentChannels]);

  // A mixed-channel shipment has no single "current" channel to preselect, so
  // fall back to the first legal target and let the operator choose.
  const initialChannel = currentChannels.length === 1 ? currentChannels[0] : "";

  const [channel, setChannel] = useState(initialChannel);
  const [recipientId, setRecipientId] = useState(currentRecipientId ?? "");
  const [notes, setNotes] = useState(currentNotes ?? "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creditedAllocations = useMemo(
    () => new Set(rows.map((r) => r.allocation_id).filter(Boolean)).size,
    [rows],
  );

  const channelChanges = !!channel && rows.some((r) => r.channel !== channel);
  const recipientChanges = recipientId !== (currentRecipientId ?? "");
  const notesChange = notes !== (currentNotes ?? "");
  const hasChanges = channelChanges || recipientChanges || notesChange;

  // Mirrors the API's guards so submit is disabled rather than round-tripping a
  // rejection: G9 (reason required on a channel change) and G7 (recipient
  // cannot be cleared).
  const canSubmit = hasChanges && !!recipientId && (!channelChanges || !!reason.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/production/shipments/${shipmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(channelChanges ? { channel } : {}),
          ...(recipientChanges
            ? {
                recipient_id: recipientId,
                recipient_name: partners.find((p) => p.id === recipientId)?.company_name ?? null,
              }
            : {}),
          ...(notesChange ? { notes: notes.trim() || null } : {}),
          ...(reason.trim() ? { edit_reason: reason.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save changes");
      // Filing-adjacent advisories (e.g. the edit crossed the excise treatment
      // line) — the change IS saved; the operator just needs to know.
      const apiWarnings: string[] = json.warnings ?? [];
      if (apiWarnings.length > 0) alert(apiWarnings.join("\n\n"));
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Edit Shipment" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {creditedAllocations > 0 && (
          <Banner tone="accent">
            This shipment currently credits {creditedAllocations} allocation
            {creditedAllocations !== 1 ? "s" : ""}. Changing its channel will release those
            credits and may reopen a fulfilled commitment.
          </Banner>
        )}

        <Field label="Channel" required>
          <select
            className="inp"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            {currentChannels.length !== 1 && (
              <option value="">Mixed — choose a channel</option>
            )}
            {targets.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c] ?? c}
              </option>
            ))}
            {/* A current channel that is not a legal target stays selectable so
                "no change" remains possible. */}
            {currentChannels.length === 1 && !targets.includes(currentChannels[0] as never) && (
              <option value={currentChannels[0]}>
                {CHANNEL_LABELS[currentChannels[0]] ?? currentChannels[0]} (current)
              </option>
            )}
          </select>
          {channel === "contract_brewing" && !currentChannels.every((c) => c === "contract_brewing") && (
            <p className="text-xs text-muted mt-1">
              No commitment is attached — the shipment bills under the contract model ad-hoc:
              packaging fees at invoice time, with the ingredient deposit offered there too.
            </p>
          )}
        </Field>

        <Field label="Customer" required>
          <select
            className="inp"
            value={recipientId}
            onChange={(e) => setRecipientId(e.target.value)}
          >
            <option value="" disabled>
              Select a customer…
            </option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.company_name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Notes">
          <textarea
            className="inp"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional"
          />
        </Field>

        <Field
          label="Reason for change"
          required={channelChanges}
          hint={channelChanges ? undefined : "(required when changing channel)"}
        >
          <input
            className="inp"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. booked to the wrong channel"
          />
        </Field>

        {error && <Banner>{error}</Banner>}

        <ModalActions
          submitting={saving}
          onCancel={onClose}
          label="Save Changes"
          disabled={!canSubmit}
        />
      </form>
    </Modal>
  );
}
