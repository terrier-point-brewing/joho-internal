"use client";
import { useState } from "react";

/**
 * Inline "Accept" / "✓ accepted (undo)" toggle for dismissing an unmapped
 * record without giving it a real GL mapping. Sits inside a table row whose
 * `<tr>` has its own row-expand onClick, so the click must not bubble.
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
      <button onClick={handleClick} className="text-2xs text-info hover:underline disabled:opacity-50" disabled={saving}>
        ✓ accepted (undo)
      </button>
    );
  }
  return (
    <button onClick={handleClick} className="text-2xs text-accent-emphasis hover:underline disabled:opacity-50" disabled={saving}>
      Accept
    </button>
  );
}
