"use client";
import { useState } from "react";

/**
 * Inline "Accept" / "Undo" toggle for dismissing an unmapped record without
 * giving it a real GL mapping. Sits alongside `MappingStatusPill`, which
 * already renders the "✓ accepted" label — this only renders the action,
 * never repeats that text. Sits inside a table row whose `<tr>` has its own
 * row-expand onClick, so the click must not bubble.
 */
export default function AcceptUnmappedButton({
  accepted,
  onToggle,
}: {
  accepted: boolean;
  onToggle: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    setSaving(true);
    try {
      await onToggle();
    } finally {
      setSaving(false);
    }
  }

  if (accepted) {
    return (
      <button onClick={handleClick} className="btn-secondary btn-xxs" disabled={saving}>
        undo
      </button>
    );
  }
  return (
    <button onClick={handleClick} className="btn-primary btn-xxs" disabled={saving}>
      Accept
    </button>
  );
}
