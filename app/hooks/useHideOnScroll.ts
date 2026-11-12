"use client";

import { useEffect, useState } from "react";

/** The app's one scroll container (app/layout.tsx). */
export const APP_PANE_ID = "app-pane";

/**
 * True while the reader is scrolling the app pane downward, false as soon as
 * they scroll up or reach the top. Drives the mobile bottom nav's auto-hide
 * (docs/UI_STANDARD.md §7, pattern D): fixed chrome gives the content back
 * while the reader is moving through it, and returns on the first upward
 * nudge, which is the gesture that means "I want to go somewhere".
 *
 * `threshold` is the scroll distance that counts as intent; small jitter
 * from a rubber-band bounce or a tap doesn't flip the state.
 */
export function useHideOnScroll(threshold = 12): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const pane = document.getElementById(APP_PANE_ID);
    if (!pane) return;
    let last = pane.scrollTop;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = pane.scrollTop;
        const delta = y - last;
        if (y <= 0) setHidden(false);
        else if (delta > threshold) setHidden(true);
        else if (delta < -threshold) setHidden(false);
        if (Math.abs(delta) > threshold) last = y;
        ticking = false;
      });
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => pane.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return hidden;
}
