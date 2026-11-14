import { TriangleAlert } from "lucide-react";

/**
 * The inline warning mark. A drawn icon, never the "⚠" character: phones
 * render that (and ▶, ⬇, ↩, 🔒 …) as a colour emoji, which is off-brand and
 * ignores the text colour. Sized and coloured by the surrounding text.
 */
export default function WarnIcon({ className = "" }: { className?: string }) {
  return <TriangleAlert aria-hidden className={`inline size-[1.1em] align-[-0.15em] ${className}`.trim()} />;
}
