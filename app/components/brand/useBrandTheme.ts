"use client";

import { useEffect, useState } from "react";

// Resolve the currently-active brand theme mode: explicit `data-theme` on
// <html> wins; otherwise fall back to the OS `prefers-color-scheme`.
function resolveMode(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Client hook returning the resolved brand theme ("light" | "dark") for JS
// consumers (e.g. brand charts that can't rely on CSS alone). Re-resolves on
// `data-theme` attribute mutations (ThemeToggle) and OS scheme changes.
export function useBrandTheme(): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">(() => resolveMode());

  useEffect(() => {
    const update = () => setMode(resolveMode());

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", update);

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    update();

    return () => {
      mql.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);

  return mode;
}
