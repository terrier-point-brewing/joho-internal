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

const inputCls =
  "bg-zinc-800 border border-zinc-600 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function ReportControls({
  start, end, onStartChange, onEndChange,
  onRun, onExport, loading, hasData,
  groupBy, groupOptions, onGroupByChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1">Start Date</label>
        <input type="date" value={start} onChange={(e) => onStartChange(e.target.value)} className={inputCls} />
      </div>
      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1">End Date</label>
        <input type="date" value={end} onChange={(e) => onEndChange(e.target.value)} className={inputCls} />
      </div>
      {groupOptions.length > 1 && (
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Group By</label>
          <select value={groupBy} onChange={(e) => onGroupByChange(e.target.value)} className={inputCls}>
            {groupOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
      <button
        onClick={onRun}
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loading ? "Loading…" : "Run Report"}
      </button>
      {hasData && onExport && (
        <button
          onClick={onExport}
          className="px-4 py-2 bg-zinc-700 border border-zinc-600 text-zinc-100 text-sm font-medium rounded-md hover:bg-zinc-600"
        >
          Export CSV
        </button>
      )}
    </div>
  );
}
