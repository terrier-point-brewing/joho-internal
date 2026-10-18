// The individual records behind one row of a trend view — a pour, a keg that
// came off, an item sale. One shape so the trend views share a drill table.
export interface TrendLine {
  /** ISO instant. */
  occurredAt: string;
  /** What it was: pour size, keg + cause, item variation. */
  label: string;
  /** Count where one exists (pours, units); null for a per-keg figure. */
  quantity: number | null;
  /** The trend's metric for this line (fl oz, dollars…). */
  value: number;
  /** Where to find it: order id tail, keg reference. */
  ref: string;
  note?: string;
}
