"use client";

import ToggleChip from "./ui/ToggleChip";
import type { TabDef } from "./TabBar";

/**
 * Exclusive-choice button row for a view/panel switcher nested one level
 * below a page's own subtab bar (e.g. Chart of Accounts' Statement/By Type
 * toggle, GL Mapping's Revenue/Expenses/... panel picker). Deliberately not
 * a TabBar: an underline tab row reads as page-level navigation, and a
 * second one directly under the real subtabs reads as a third nav level
 * that isn't there. Chips make clear this switches a view within the page,
 * not the page itself.
 *
 * `collapse` (docs/UI_STANDARD.md §7 E): on a handheld the chips become one
 * native `<select>`. Three chip groups are three toolbar rows on a phone and
 * push the content off the first screen; three selects are one row, and the
 * OS picker is a better touch target than a 28px chip. Needs `label`, which
 * names the select for a screen reader. Labels must be plain strings.
 */
export default function ButtonGroup<K extends string>({
  tabs,
  activeKey,
  onSelect,
  className = "",
  label,
  collapse = false,
}: {
  tabs: TabDef<K>[];
  activeKey: K;
  onSelect: (key: K) => void;
  className?: string;
  /** Accessible name; required with `collapse`. */
  label?: string;
  collapse?: boolean;
}) {
  return (
    <>
      <div
        role="group"
        aria-label={label}
        className={`flex items-center gap-1.5 flex-wrap ${collapse ? "handheld:hidden" : ""} ${className}`.replace(/\s+/g, " ").trim()}
      >
        {tabs.map(({ key, label: text }) => (
          <ToggleChip key={key} active={key === activeKey} onClick={() => onSelect(key)}>
            {text}
          </ToggleChip>
        ))}
      </div>
      {collapse && (
        <select
          aria-label={label}
          value={activeKey}
          onChange={(e) => onSelect(e.target.value as K)}
          className="inp-sm w-auto desk:hidden"
        >
          {tabs.map(({ key, label: text }) => (
            <option key={key} value={key}>{text}</option>
          ))}
        </select>
      )}
    </>
  );
}
