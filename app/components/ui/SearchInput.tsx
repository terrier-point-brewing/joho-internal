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
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // keep local text in sync when the controlled value changes externally (e.g. reset)
  useEffect(() => {
    setText(value);
  }, [value]);

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
