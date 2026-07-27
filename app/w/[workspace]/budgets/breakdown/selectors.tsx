import { Link } from "@/ui/chrome/workspace-context";
import { BUDGET_VIEWS, BUDGET_VIEW_LABELS, type BudgetView } from "@/lib/server/metrics/budget";
import type { BudgetRef } from "@/lib/server/metrics/budget";

// The two filter rows above the table.
//
// Anchors rather than toggles, for the reason ui/dashboard/comparison/selector.tsx
// gives about the period selector: changing either of these is navigation. It
// drives the URL, it should open in a new tab, and it works with JavaScript off.

const PILL = "shrink-0 rounded-md px-2.5 py-1.5 whitespace-nowrap";
const ON = "bg-foreground text-background";
const OFF = "text-secondary hover:bg-current/5";

/**
 * Which of the three the table shows.
 *
 * A switch rather than extra columns. Pairing budget and actual side by side
 * would double a table that is already `min-w-3xl` at six periods, whereas three
 * views of one table compare by a flick and keep the column layout people
 * already know from `/breakdown`.
 */
export function ViewSelector({ view, href }: { view: BudgetView; href: (view: BudgetView) => string }) {
  return (
    <nav className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 text-sm">
      {BUDGET_VIEWS.map((option) => (
        <Link
          key={option}
          href={href(option)}
          aria-current={option === view ? "page" : undefined}
          className={`${PILL} ${option === view ? ON : OFF}`}
        >
          {BUDGET_VIEW_LABELS[option]}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Which base the view is built on.
 *
 * Single-select: the plan is one base plus the layers that belong to it, added on
 * automatically while their own windows are live. There is no cross-budget
 * multi-select any more — layering is the base's own layers, not an arbitrary pile
 * of unrelated budgets.
 */
export function BudgetSelector({
  available,
  selectedId,
  href,
}: {
  available: BudgetRef[];
  selectedId: string | null;
  href: (budget: BudgetRef) => string;
}) {
  // One base is not a choice; the label already says which, so the row is noise.
  if (available.length <= 1) return null;

  return (
    <nav className="-mx-1 flex flex-wrap items-center gap-1 px-1 text-sm">
      <span className="px-1 text-xs text-muted">Base</span>
      {available.map((budget) => {
        const on = budget.id === selectedId;
        return (
          <Link
            key={budget.id}
            href={href(budget)}
            aria-current={on ? "page" : undefined}
            className={`${PILL} ${on ? ON : OFF}`}
          >
            {budget.name}
          </Link>
        );
      })}
    </nav>
  );
}
