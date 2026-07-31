"use client";

import { useEffect, useRef } from "react";

/**
 * Debounce a callback, resetting the timer on every value change.
 *
 * Extracted from the search form's `useEffect` so its dependency array is
 * honest — the effect in the form had `eslint-disable react-hooks/exhaustive-deps`
 * because it depended on `[value]` while reading `urlQuery` and `navigate`. This
 * hook takes the callback as a ref, so the effect's only dependency is `value`
 * and the lint rule is satisfied without a suppression.
 */
export function useDebouncedCallback(value: string, callback: () => void, delayMs: number) {
  const ref = useRef(callback);
  useEffect(() => {
    ref.current = callback;
  });

  useEffect(() => {
    const id = setTimeout(() => ref.current(), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
}
