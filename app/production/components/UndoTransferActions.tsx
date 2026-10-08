"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "./shared";
import { fmtDateTime } from "@/lib/utils/formatting";

interface UndoableAction {
  id: string;
  batch_id: string;
  transfer_type: string | null;
  summary: string | null;
  created_at: string;
  /** Why the server will refuse this one, in words for the brewer. Null = undoable. */
  blocked_reason: string | null;
}

/**
 * The floorplan's Undo: recent moves and packaging runs, newest first, each
 * reversible in one click while nothing has been built on top of it. Lives in
 * the header rather than on a tile because the mistake often removes the tile —
 * kegging a tank dry takes the batch off the floorplan altogether.
 */
export default function UndoTransferActions({ onUndone }: { onUndone: () => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  // Fetched only while the list is open, and fresh each time: whether an action
  // is still undoable changes with every transfer, shipment and schedule edit.
  const { data: actions, isLoading, error, refetch } = useQuery<UndoableAction[]>({
    queryKey: ["production", "transferUndo"],
    queryFn: async () => {
      const res = await fetch("/api/production/transfers/undo");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load recent actions.");
      return res.json();
    },
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });

  async function undo(action: UndoableAction) {
    if (!confirm(`Undo this?\n\n${action.summary ?? "Floorplan action"}\n\nThe floorplan, schedule, cold storage and packaging stock go back to how they were before it.`)) return;
    setUndoingId(action.id);
    try {
      const res = await fetch("/api/production/transfers/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_id: action.id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await onUndone();
      await refetch();
    } catch (e: unknown) {
      alert(`Could not undo: ${e instanceof Error ? e.message : "Error"}`);
      await refetch();
    } finally {
      setUndoingId(null);
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-secondary">↩ Undo</button>

      {open && (
        <Modal title="Undo a floorplan action" onClose={() => setOpen(false)}>
          {isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : error ? (
            <p className="text-sm text-danger">{(error as Error).message}</p>
          ) : (actions ?? []).length === 0 ? (
            <p className="text-sm text-muted">No moves or packaging runs in the last 7 days.</p>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {(actions ?? []).map((a) => (
                <div key={a.id} className="flex items-center gap-3 p-2.5 rounded bg-surface/60 border border-line">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-primary">{a.summary ?? "Floorplan action"}</p>
                    <p className="text-xs text-muted">{fmtDateTime(a.created_at)}</p>
                    {a.blocked_reason && (
                      <p className="text-xs text-danger mt-0.5">Can&apos;t undo: {a.blocked_reason}</p>
                    )}
                  </div>
                  <button
                    onClick={() => undo(a)}
                    disabled={!!a.blocked_reason || undoingId !== null}
                    className="btn-danger shrink-0"
                  >
                    {undoingId === a.id ? "Undoing…" : "Undo"}
                  </button>
                </div>
              ))}
              <p className="text-xs text-muted pt-1">
                Only the latest action on each batch is listed. Conversions can&apos;t be undone here.
              </p>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
