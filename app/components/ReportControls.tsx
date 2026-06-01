"use client";

interface Props {
  start: string;
  end: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  onRun: () => void;
  onExport?: () => void;
  loading: boolean;
  hasData: boolean;
  groupByItem: boolean;
  onGroupByItemChange: (v: boolean) => void;
}

export default function ReportControls({
  start, end, onStartChange, onEndChange,
  onRun, onExport, loading, hasData,
  groupByItem, onGroupByItemChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label className="block text-sm font-medium text-gray-800 mb-1">Start Date</label>
        <input
          type="date"
          value={start}
          onChange={(e) => onStartChange(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-800 mb-1">End Date</label>
        <input
          type="date"
          value={end}
          onChange={(e) => onEndChange(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-800 mb-1">Group By</label>
        <select
          value={groupByItem ? "item" : "date"}
          onChange={(e) => onGroupByItemChange(e.target.value === "item")}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="date">Date</option>
          <option value="item">Item</option>
        </select>
      </div>
      <button
        onClick={onRun}
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "Loading…" : "Run Report"}
      </button>
      {hasData && onExport && (
        <button
          onClick={onExport}
          className="px-4 py-2 bg-white border border-gray-300 text-gray-800 text-sm font-medium rounded-md hover:bg-gray-50"
        >
          Export CSV
        </button>
      )}
    </div>
  );
}
