"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

const themeOptions = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

// False during SSR and the first client render, true thereafter — the standard
// mount check, expressed with useSyncExternalStore so there's no setState in an
// effect (which the lint rules, rightly, forbid). Its subscribe never fires; the
// value simply differs between the server and client snapshots.
const noop = () => () => {};
function useMounted() {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/**
 * Light/dark/system switch. next-themes only knows the resolved value after
 * mount (the server can't read the OS), so the tick is withheld until mounted to
 * avoid a hydration mismatch — the items are fully usable before then.
 * `closeOnClick={false}` keeps the menu open so you can see the theme change.
 */
export function ThemeItems() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <>
      {themeOptions.map(({ value, label, icon: Icon }) => (
        <DropdownMenuItem
          key={value}
          closeOnClick={false}
          onClick={() => setTheme(value)}
        >
          <Icon />
          {label}
          {mounted && theme === value ? (
            <CheckIcon className="ml-auto size-4" />
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}
