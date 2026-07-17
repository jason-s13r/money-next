import { Link } from "@/ui/chrome/workspace-context";

// One prev/next navigation row: a link on each end that greys out (rather than
// disappearing) when there is nowhere to go, so the control keeps its shape at the
// ends of the road. An optional centre — "Page 3 of 9" — sits between them. Shared
// by the transaction pager (Pagination) and the comparison window pager.

function End({ href, label }: { href: string | null; label: string }) {
  return href ? (
    <Link href={href} className="underline underline-offset-2">
      {label}
    </Link>
  ) : (
    <span className="opacity-30">{label}</span>
  );
}

export function NavPair({
  left,
  right,
  center,
  className = "",
}: {
  left: { href: string | null; label: string };
  right: { href: string | null; label: string };
  /** Optional middle element (e.g. a page counter). Omitted, the two ends sit at
   *  the edges; present, all three space out evenly. */
  center?: React.ReactNode;
  className?: string;
}) {
  return (
    <nav className={`flex items-center justify-between text-sm ${className}`}>
      <End href={left.href} label={left.label} />
      {center}
      <End href={right.href} label={right.label} />
    </nav>
  );
}
