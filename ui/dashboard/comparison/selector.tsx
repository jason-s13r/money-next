import Link from "next/link";
import { PERIOD_LABELS, PERIODS, type Period } from "@/lib/periods";

export function PeriodSelector({ period, href }: { period: Period; href: string }) {
  return (
    // One filter row above everything it scopes, never inside a chart card.
    // Changing the period resets to the most recent window, so no page carries.
    <nav className="flex flex-wrap items-center gap-1 text-sm">
      {PERIODS.map((option) => (
        <Link
          key={option}
          href={`${href}?period=${option}`}
          aria-current={option === period ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 ${
            option === period
              ? "bg-foreground text-background"
              : "text-secondary hover:bg-current/5"
          }`}
        >
          {PERIOD_LABELS[option]}
        </Link>
      ))}
    </nav>
  );
}
