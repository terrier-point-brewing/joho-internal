"use client";

import { useState } from "react";
import ButtonGroup from "@/app/components/ButtonGroup";
import { CUSTOM_WINDOW_RE, isCustomWindow, type TrendWindow } from "@/lib/reports/draftTrend";

/**
 * Range control for the trend views: preset day counts plus a "Custom" chip
 * that opens from/to date inputs. The value is one string (see TrendWindow)
 * so it can key a query and ride a URL unchanged.
 */
export default function TrendWindowPicker({
  presets, value, onChange, today,
}: {
  presets: { key: string; label: string }[];
  value: TrendWindow;
  onChange: (w: TrendWindow) => void;
  /** Brewery-local today, the latest selectable end. */
  today: string;
}) {
  const custom = isCustomWindow(value);
  const m = CUSTOM_WINDOW_RE.exec(value);
  // Drafts live here until both ends are valid; the parent only ever sees a
  // complete window, so a half-typed date can't fire a fetch.
  const [from, setFrom] = useState(m?.[1] ?? "");
  const [to, setTo] = useState(m?.[2] ?? today);
  const [open, setOpen] = useState(custom);

  function commit(f: string, t: string) {
    setFrom(f); setTo(t);
    if (/^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
      const [lo, hi] = f <= t ? [f, t] : [t, f];
      onChange(`${lo}..${hi > today ? today : hi}`);
    }
  }

  const tabs = [...presets, { key: "custom", label: "Custom" }];
  const activeKey = custom || open ? "custom" : value;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ButtonGroup
        tabs={tabs}
        activeKey={activeKey}
        onSelect={(k) => {
          if (k === "custom") { setOpen(true); commit(from, to); return; }
          setOpen(false);
          onChange(k);
        }}
      />
      {(custom || open) && (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <input type="date" aria-label="From" className="inp-sm w-auto" value={from} max={today}
            onChange={(e) => commit(e.target.value, to)} />
          –
          <input type="date" aria-label="To" className="inp-sm w-auto" value={to} max={today}
            onChange={(e) => commit(from, e.target.value)} />
        </span>
      )}
    </div>
  );
}
