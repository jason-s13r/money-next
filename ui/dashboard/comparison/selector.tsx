import { Link } from "@/ui/chrome/workspace-context";
import {
  FIXED_PERIODS,
  hasTaxForm,
  PERIOD_LABELS,
  type Basis,
  type FixedPeriod,
} from "@/lib/periods";

/** The query fragment that carries a basis. Calendar is the default, so it is
 *  left out rather than spelled — the plain url stays the plain view. */
export const basisParam = (basis: Basis) => (basis === "tax" ? "&basis=tax" : "");

export const flipped = (basis: Basis): Basis => (basis === "tax" ? "calendar" : "tax");

export function PeriodSelector({
  view,
  basis,
  href,
  basisHref,
}: {
  view: FixedPeriod;
  basis: Basis;
  href: string;
  /** The same view with the basis flipped. Built by the page, which alone knows
   *  what else its url carries — flipping keeps the window, unlike a new period. */
  basisHref: string;
}) {
  const tax = basis === "tax";
  return (
    // One filter row above everything it scopes, never inside a chart card.
    // Changing the period resets to the most recent window, so no page carries.
    // Kept as anchors (not a ToggleGroup) because changing period is navigation —
    // it drives the URL and should open in a new tab. On a phone the options
    // overflow, so the row scrolls horizontally rather than wrapping.
    <nav className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 text-sm">
      {FIXED_PERIODS.map((option) => (
        // The basis rides along even onto Day and Week, which ignore it, so
        // passing through them on the way to another tab does not drop it.
        <Link
          key={option}
          href={`${href}?period=${option}${basisParam(basis)}`}
          aria-current={option === view ? "page" : undefined}
          className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 ${
            option === view
              ? "bg-primary text-primary-foreground"
              : "text-secondary hover:bg-current/5"
          }`}
        >
          {PERIOD_LABELS[option]}
        </Link>
      ))}
      {hasTaxForm(view) ? (
        <Link
          href={basisHref}
          aria-pressed={tax}
          title={tax ? "Cut from the tax year" : "Cut from the calendar year"}
          className={`ml-1 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 ${
            tax
              ? "border-primary text-primary"
              : "border-current/15 text-secondary hover:bg-current/5"
          }`}
        >
          <span
            aria-hidden
            className={`grid size-3.5 place-items-center rounded-sm border text-[10px] leading-none ${
              tax ? "border-primary bg-primary text-primary-foreground" : "border-current/40"
            }`}
          >
            {tax ? "✓" : null}
          </span>
          Tax year
        </Link>
      ) : null}
    </nav>
  );
}
