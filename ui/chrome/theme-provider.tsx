"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

// Wraps next-themes so the rest of the app can stay server components. We toggle
// the `.dark` class on <html> (attribute="class"), defaulting to the OS setting
// (defaultTheme="system" + enableSystem) — which reproduces the old
// prefers-color-scheme behaviour — while making a manual light/dark switch
// possible. `disableTransitionOnChange` stops every colour animating at once on
// a theme flip.
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
