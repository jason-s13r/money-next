import { requireWorkspace } from "@/lib/server/auth/session";
import { getTaxYear } from "@/lib/server/queries/tax-year";
import { TAX_YEAR_START_DAY_MAX } from "@/lib/server/tax-year";
import { TaxYearForm } from "./tax-year-form";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata = { title: "Settings" };

/**
 * What this workspace has decided about itself, as distinct from what its
 * members have decided about individual transactions.
 *
 * One setting so far: where the tax year starts. It earns a page rather than a
 * corner of /members because it is not about people — and because changing it
 * silently re-buckets every tax-year figure in the app, which is worth doing
 * somewhere that says what it is.
 *
 * Shown to everyone and editable by owners, the same split /members uses: knowing
 * which year your household's totals are cut on is not a privilege, and hiding the
 * controls from a non-owner is a rendering decision rather than the control. The
 * action opens with `requireRole` regardless (a server action is a public POST).
 */
export default async function SettingsPage() {
  const { workspace, role } = await requireWorkspace();
  const taxYear = await getTaxYear();

  return (
    <main className="mx-auto w-full max-w-3xl p-2">
      <header className="mb-6">
        <h1 className="sr-only">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Settings for {workspace.name}, shared by everyone in it.
        </p>
      </header>

      <section>
        <div className="border-b border-current/20 pb-2">
          <h2 className="text-sm font-medium opacity-60">Tax year</h2>
        </div>

        <p className="mt-4 text-sm text-muted">
          Which day the household&rsquo;s tax year opens on. Every &ldquo;Tax
          year&rdquo; column in the breakdowns is cut here, and a tax year is named
          for the calendar year it ends in.
        </p>

        <TaxYearForm
          taxYear={taxYear}
          dayMax={TAX_YEAR_START_DAY_MAX}
          canEdit={role === "owner"}
        />
      </section>
    </main>
  );
}
