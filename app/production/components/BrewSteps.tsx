import EditGrid from "@/app/components/ui/EditGrid";
import ListTable from "@/app/components/ui/ListTable";

/**
 * Brew steps, read and edit. A recipe and a brew step template hold the same
 * five fields, so both screens share one table and one editor.
 */

export type BrewStepView = {
  activity: string;
  time_label?: string | null;
  temp?: number | string | null;
  temp_unit?: string | null;
  amount?: number | string | null;
  amount_unit?: string | null;
  vsp?: number | string | null;
};

const has = (v: unknown) => v != null && v !== "";

export function BrewStepsTable({ steps, className = "" }: { steps: BrewStepView[]; className?: string }) {
  return (
    <ListTable<BrewStepView>
      rows={steps}
      rowKey={(_, i) => i}
      dense
      className={className}
      cols={[
        { key: "n", header: "#", fold: false, className: "text-xs text-faint tabular-nums w-8", cell: (_, i) => i + 1 },
        { key: "activity", header: "Activity", role: "label", className: "!font-normal !text-body", cell: (s) => s.activity },
        { key: "time", header: "Time (min)", align: "right", className: "text-xs text-muted tabular-nums", cell: (s) => (has(s.time_label) ? s.time_label : null), fold: (s) => (has(s.time_label) ? `${s.time_label} min` : null) },
        { key: "temp", header: "Temp", align: "right", className: "text-xs text-muted tabular-nums", cell: (s) => (has(s.temp) ? `${s.temp}°${s.temp_unit ?? "F"}` : null) },
        {
          key: "amount", header: "Amount", align: "right", foldLabel: "Amount", className: "text-xs text-muted tabular-nums",
          cell: (s) => (has(s.amount) ? `${typeof s.amount === "number" ? s.amount.toLocaleString() : s.amount}${s.amount_unit ? ` ${s.amount_unit}` : ""}` : null),
        },
        { key: "vsp", header: "VSP", align: "right", foldLabel: "VSP", className: "text-xs text-muted tabular-nums", cell: (s) => (has(s.vsp) ? String(s.vsp) : null) },
      ]}
    />
  );
}

export type BrewStepDraft = { activity: string; time_label: string; temp: string; amount: string; vsp: string };

export function BrewStepsEditor<T extends BrewStepDraft>({
  steps, onChange, onRemove,
}: {
  steps: T[];
  onChange: (index: number, step: T) => void;
  onRemove: (index: number) => void;
}) {
  const num = (field: "time_label" | "temp" | "amount" | "vsp", step: string, placeholder: string) => ({
    cell: (s: T, i: number) => (
      <input type="number" step={step} className="inp-sm text-right w-full" placeholder={placeholder}
        value={s[field]} onChange={(e) => onChange(i, { ...s, [field]: e.target.value })} />
    ),
  });
  return (
    <EditGrid<T>
      rows={steps}
      onRemove={onRemove}
      itemLabel="Step"
      cols={[
        {
          key: "activity", header: "Activity", wide: true,
          cell: (s, i) => (
            <input className="inp-sm w-full" placeholder="e.g. Mash in" value={s.activity}
              onChange={(e) => onChange(i, { ...s, activity: e.target.value })} />
          ),
        },
        { key: "time", header: "Time (min)", align: "right", width: "sm:w-20", ...num("time_label", "1", "0") },
        { key: "temp", header: "Temp (°F)", align: "right", width: "sm:w-20", ...num("temp", "0.1", "152") },
        { key: "amount", header: "Amount", align: "right", width: "sm:w-20", ...num("amount", "0.01", "0") },
        { key: "vsp", header: "VSP", align: "right", width: "sm:w-20", ...num("vsp", "0.1", "0") },
      ]}
    />
  );
}
