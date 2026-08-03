"use client";

import { useSyncExternalStore } from "react";
import { resolveThemeAttr, THEME_COOKIE, type ThemeChoice } from "@/lib/brand/theme";
import ToggleChip from "@/app/components/ui/ToggleChip";

const OPTIONS: { choice: ThemeChoice; label: string }[] = [
  { choice: "light", label: "Light" },
  { choice: "dark", label: "Dark" },
  { choice: "system", label: "System" },
];

const THEME_EVENT = "brand-theme-change";

// The active choice is read from the live `data-theme` attribute (stamped by
// the pre-hydration script from the cookie), NOT from React state — so SSR and
// the first client render agree via getServerSnapshot ("system"), avoiding a
// hydration mismatch, and there is no setState-in-effect.
function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}
function getSnapshot(): ThemeChoice {
  const attr = document.documentElement.dataset.theme;
  return attr === "light" || attr === "dark" ? attr : "system";
}
function getServerSnapshot(): ThemeChoice {
  return "system";
}

// Persist the choice and apply data-theme immediately (no reload), then notify
// the store so the control re-renders with the new selection.
function applyThemeChoice(next: ThemeChoice) {
  document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000`;

  const attr = resolveThemeAttr(next);
  if (attr) {
    document.documentElement.dataset.theme = attr;
  } else {
    delete document.documentElement.dataset.theme;
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

// Three-state light/dark/system control for the Joho brand surfaces.
export default function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Theme">
      {OPTIONS.map(({ choice: optionChoice, label }) => (
        <ToggleChip
          key={optionChoice}
          active={choice === optionChoice}
          onClick={() => applyThemeChoice(optionChoice)}
        >
          {label}
        </ToggleChip>
      ))}
    </div>
  );
}
