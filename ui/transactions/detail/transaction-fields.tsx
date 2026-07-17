import { Link } from "@/ui/chrome/workspace-context";

// The labelled field rows that make up a transaction's detail page: a titled
// section wrapping a definition list, a plain read-only field, and an editable
// field whose control fills the value cell. Presentational only — the page wires
// in the values and the editing controls.

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 border-b border-current/20 pb-2 text-sm font-medium opacity-60">
        {title}
      </h2>
      <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-6 gap-y-3 text-sm">
        {children}
      </dl>
    </section>
  );
}

/**
 * A labelled row whose value is editable: the control fills the value cell, and
 * when the current value has a list page a small link sits beneath it so the
 * page is still one click away.
 */
export function EditableField({
  label,
  value,
  href,
  children,
}: {
  label: string;
  value: string | null;
  href: string | null;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="opacity-60">{label}</dt>
      <dd className="flex flex-col items-start gap-1">
        {children}
        {value && href ? (
          <Link
            href={href}
            className="text-xs text-muted underline underline-offset-2 hover:text-foreground"
          >
            View {value}
          </Link>
        ) : null}
      </dd>
    </>
  );
}

export function Field({
  label,
  value,
  mono = false,
  href = null,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  /** Makes the value a link to the list of everything else like it. */
  href?: string | null;
}) {
  const empty = value === null || value === "" || value === undefined;

  return (
    <>
      <dt className="opacity-60">{label}</dt>
      <dd className={`break-all ${mono ? "font-mono text-xs" : ""}`}>
        {empty ? (
          <span className="opacity-40">—</span>
        ) : href ? (
          <Link href={href} className="underline underline-offset-2">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </>
  );
}
