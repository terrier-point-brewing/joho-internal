"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Transient inline auto-save indicator for the finance ledgers. Shows "saving…"
 * while `saving` is true, then "saved ✓" for ~1.5s once it flips back to false,
 * then nothing. Gives every auto-save surface (Orders / Invoices / Bank Ledger /
 * Account Mapping / Counterparty) one consistent persistence cue so a silent
 * PATCH never leaves the user unsure whether the change stuck. See the finance UI
 * plan, finding H4.
 */
export default function SaveHint({
  saving,
  className = "",
}: {
  saving: boolean;
  className?: string;
}) {
  const [showSaved, setShowSaved] = useState(false);
  const prev = useRef(saving);

  useEffect(() => {
    if (prev.current && !saving) {
      setShowSaved(true); // eslint-disable-line react-hooks/set-state-in-effect
      prev.current = saving;
      const t = setTimeout(() => setShowSaved(false), 1500);
      return () => clearTimeout(t);
    }
    prev.current = saving;
  }, [saving]);

  if (saving) return <span className={`text-2xs text-faint animate-pulse ${className}`.trim()}>saving…</span>;
  if (showSaved) return <span className={`text-2xs text-success ${className}`.trim()}>saved ✓</span>;
  return null;
}
