import Link from "next/link";
import type { MatchingRule } from "@/lib/server/data";
import { RuleOutputs } from "@/ui/rules/rule-output";

// The "Automation" panel on a transaction page: which rules act on *this* row
// (see `getRulesForTransaction`), and — as children — the button to teach a new
// one. The first matching rule is the one that fires; the rest are shadowed by it
// (the decision table's first-match policy), shown so a surprising classification
// is explainable rather than mysterious.
export function MatchingRules({
  matching,
  transferMatches,
  children,
}: {
  matching: MatchingRule[];
  transferMatches: boolean;
  children: React.ReactNode;
}) {
  const nothingMatches = matching.length === 0 && !transferMatches;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between border-b border-current/20 pb-2 text-sm font-medium opacity-60">
        <span>Automation</span>
        <Link href="/rules" className="font-normal underline-offset-2 hover:underline">
          Manage rules →
        </Link>
      </div>

      <div className="mt-3 space-y-3">
        {nothingMatches ? (
          <p className="text-xs text-muted">No rules match this transaction yet.</p>
        ) : (
          <ul className="space-y-2">
            {matching.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                {rule.applied ? (
                  <span className="rounded bg-status-good/15 px-1.5 py-0.5 text-xs font-medium text-status-good">
                    Applied
                  </span>
                ) : (
                  <span
                    className="rounded bg-current/10 px-1.5 py-0.5 text-xs text-muted"
                    title="A rule above this one already matched, so this one doesn't fire."
                  >
                    Shadowed
                  </span>
                )}
                {rule.match.type ? (
                  <span className="rounded bg-current/10 px-1.5 py-0.5 font-mono text-xs">
                    {rule.match.type}
                  </span>
                ) : null}
                {rule.match.tokens.map((t) => (
                  <span key={t} className="rounded bg-current/10 px-1.5 py-0.5 font-mono text-xs">
                    {t}
                  </span>
                ))}
                <span className="opacity-50">→</span>
                <RuleOutputs categoryName={rule.categoryName} merchantName={rule.merchantName} />
              </li>
            ))}
            {transferMatches ? (
              <li className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="rounded bg-status-good/15 px-1.5 py-0.5 text-xs font-medium text-status-good">
                  Applied
                </span>
                <span className="opacity-70">Auto-link transfer — groups the opposite leg when one is found.</span>
              </li>
            ) : null}
          </ul>
        )}

        {children}
      </div>
    </section>
  );
}
