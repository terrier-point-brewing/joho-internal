"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Debounced, field-scoped search box. The placeholder MUST name the field(s)
 * it searches (e.g. "Search recipes…") per the search/filter standard.
 */
export default function SearchInput({
  value,
  onChange,
  placeholder,
  debounceMs = 200,
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  debounceMs?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value);
  const [prevValue, setPrevValue] = useState(value);

  // Adjust local text when the controlled value changes externally (e.g. reset).
  // React's "store info from previous renders" pattern — no effect, so it never
  // triggers a cascading render (see https://react.dev/reference/react/useState).
  if (value !== prevValue) {
    setPrevValue(value);
    setText(value);
  }

  // Keep a live ref to onChange so the debounce timer never fires a stale one.
  // Updated in an effect (not during render) to satisfy the refs-in-render rule.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (text === value) return;
    const id = setTimeout(() => onChangeRef.current(text), debounceMs);
    return () => clearTimeout(id);
  }, [text, value, debounceMs]);

  return (
    <input
      type="search"
      value={text}
      onChange={(e) => setText(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      className={`inp-sm max-w-xs ${className}`.trim()}
    />
  );
}
