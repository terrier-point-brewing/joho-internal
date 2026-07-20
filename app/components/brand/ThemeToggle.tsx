"use client";

import { useState } from "react";
import { resolveThemeAttr, THEME_COOKIE, type ThemeChoice } from "@/lib/brand/theme";

const OPTIONS: { choice: ThemeChoice; label: string }[] = [
  { choice: "light", label: "Light" },
  { choice: "dark", label: "Dark" },
  { choice: "system", label: "System" },
];

function currentChoice(): ThemeChoice {
  if (typeof document === "undefined") return "system";
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return "system";
}

// Kept outside the component so the React Compiler doesn't treat the
// document mutations below as part of the component's render effects.
function applyThemeChoice(next: ThemeChoice) {
  document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000`;

  const attr = resolveThemeAttr(next);
  if (attr) {
    document.documentElement.dataset.theme = attr;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

// Three-state light/dark/system control for the Joho brand surfaces. Writes
// the theme cookie and applies the `data-theme` attribute immediately (no
// reload) so preview surfaces update in place.
export default function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => currentChoice());

  function handleSelect(next: ThemeChoice) {
    setChoice(next);
    applyThemeChoice(next);
  }

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Theme">
      {OPTIONS.map(({ choice: optionChoice, label }) => (
        <button
          key={optionChoice}
          type="button"
          onClick={() => handleSelect(optionChoice)}
          aria-pressed={choice === optionChoice}
          className={`btn-xxs ${choice === optionChoice ? "btn-primary" : "btn-secondary"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
