import { Link } from "@/ui/chrome/workspace-context";
import { PERIOD_LABELS, PERIODS, type Period } from "@/lib/periods";

export function PeriodSelector({ period, href }: { period: Period; href: string }) {
  return (
    // One filter row above everything it scopes, never inside a chart card.
    // Changing the period resets to the most recent window, so no page carries.
    // Kept as anchors (not a ToggleGroup) because changing period is navigation —
    // it drives the URL and should open in a new tab. On a phone the six options
    // overflow, so the row scrolls horizontally rather than wrapping.
    <nav className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 text-sm">
      {PERIODS.map((option) => (
        <Link
          key={option}
          href={`${href}?period=${option}`}
          aria-current={option === period ? "page" : undefined}
          className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 ${
            option === period
              ? "bg-primary text-primary-foreground"
              : "text-secondary hover:bg-current/5"
          }`}
        >
          {PERIOD_LABELS[option]}
        </Link>
      ))}
    </nav>
  );
}
