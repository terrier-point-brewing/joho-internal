import { clampPos, sliderTicks } from "./blockHelpers";

/**
 * One calibration axis: two poles, a marked position, a numeric readout, and
 * the note explaining what that position means.
 *
 * The hierarchy is deliberately inverted from what the guide used to show.
 * Previously the pole labels and the note shared one class, so neither stood
 * out and the note — the only line that actually tells you how to write —
 * disappeared. Here the note is the primary text and the poles are small muted
 * axis ends. The readout exists because a dot on a track communicates "roughly
 * right of centre" and nothing more precise.
 */
export default function SliderRow({
  left,
  right,
  pos,
  note,
}: {
  left: string;
  right: string;
  pos: number;
  note: string;
}) {
  const value = clampPos(pos);

  return (
    <div className="rounded-lg border border-brand-line p-3">
      <div className="flex items-center gap-3">
        <span className="font-brand-body text-2xs text-brand-content-muted w-16 text-right shrink-0">
          {left}
        </span>

        <div className="relative flex-1 h-1 rounded bg-brand-line">
          {sliderTicks().map((tick) => (
            <span
              key={tick}
              className="absolute top-1/2 h-1.5 w-px -translate-y-1/2 bg-brand-line-strong"
              style={{ left: `${tick}%` }}
              aria-hidden="true"
            />
          ))}
          <span
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-accent"
            style={{ left: `${value}%` }}
          />
        </div>

        <span className="font-brand-body text-2xs text-brand-content-muted w-16 shrink-0">
          {right}
        </span>
        <span className="font-brand-body text-sm tabular-nums text-brand-high-contrast w-8 text-right shrink-0">
          {value}
        </span>
      </div>

      <p className="font-brand-body text-sm text-brand-content mt-2 leading-relaxed">{note}</p>
    </div>
  );
}
