"use client";

import { Modal } from "@/app/components/ui/Modal";
import ScheduleBatchForm, { type CommittedBatch } from "./ScheduleBatchForm";
import { useRecipesQuery, useEquipmentQuery, useContractPartnersQuery } from "../../hooks/queries";

/**
 * THE way a brewed batch is created — from Intake (a Plan row, a commitment)
 * and from Brewing (floorplan backlog, Batch Log). One form means every new
 * batch gets its tanks booked and its beer allocated at birth, saved in one
 * server call. Loads its own data so any screen can open it.
 *
 * `recipeId: null` = let the brewer pick the beer.
 */
export default function ScheduleBatchModal({ recipeId, onClose, onCommitted }: {
  recipeId: string | null;
  onClose: () => void;
  onCommitted: (batch: CommittedBatch) => void;
}) {
  const { data: recipes = [], isPending: recipesPending } = useRecipesQuery();
  const { data: tanks = [], isPending: tanksPending } = useEquipmentQuery();
  const { data: partners = [] } = useContractPartnersQuery();

  return (
    <Modal title="Schedule a batch" onClose={onClose} extraWide>
      {recipesPending || tanksPending ? (
        <p className="text-faint text-sm py-10 text-center">Loading…</p>
      ) : (
        <ScheduleBatchForm
          key={recipeId ?? "new"}
          recipes={recipes}
          tanks={tanks}
          partners={partners}
          recipeId={recipeId}
          onCancel={onClose}
          onCommitted={onCommitted}
        />
      )}
    </Modal>
  );
}
