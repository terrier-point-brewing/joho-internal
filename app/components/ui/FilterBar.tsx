import type { ReactNode } from "react";

/**
 * Layout container for a table's controls. Pages compose SearchInput /
 * FilterChips / FilterSelect (and domain selectors like YearSelect) as children.
 * Renders a "Clear (N)" button when activeCount > 0 and onClear is provided.
 */
export default function FilterBar({
  children,
  activeCount = 0,
  onClear,
  className = "",
}: {
  children: ReactNode;
  activeCount?: number;
  onClear?: () => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 flex-wrap ${className}`.trim()}>
      {children}
      {onClear && activeCount > 0 && (
        <button type="button" onClick={onClear} className="btn-secondary btn-xxs">
          Clear ({activeCount})
        </button>
      )}
    </div>
  );
}
