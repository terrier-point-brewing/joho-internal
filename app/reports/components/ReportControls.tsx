"use client";

export interface GroupOption {
  value: string;
  label: string;
}

interface Props {
  start: string;
  end: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  onRun: () => void;
  onExport?: () => void;
  loading: boolean;
  hasData: boolean;
  groupBy: string;
  groupOptions: GroupOption[];
  onGroupByChange: (v: string) => void;
}

export default function ReportControls({
  start, end, onStartChange, onEndChange,
  onRun, onExport, loading, hasData,
  groupBy, groupOptions, onGroupByChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label className="block text-sm font-medium text-body mb-1">Start Date</label>
        <input type="date" value={start} onChange={(e) => onStartChange(e.target.value)} className="inp" />
      </div>
      <div>
        <label className="block text-sm font-medium text-body mb-1">End Date</label>
        <input type="date" value={end} onChange={(e) => onEndChange(e.target.value)} className="inp" />
      </div>
      {groupOptions.length > 1 && (
        <div>
          <label className="block text-sm font-medium text-body mb-1">Group By</label>
          <select value={groupBy} onChange={(e) => onGroupByChange(e.target.value)} className="inp">
            {groupOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
      <button onClick={onRun} disabled={loading} className="btn-amber">
        {loading ? "Loading…" : "Run Report"}
      </button>
      {hasData && onExport && (
        <button onClick={onExport} className="btn-ghost">
          Export CSV
        </button>
      )}
    </div>
  );
}
