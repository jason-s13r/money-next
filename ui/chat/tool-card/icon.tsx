import {
  DatabaseIcon,
  InboxIcon,
  ListIcon,
  PencilIcon,
  SearchIcon,
  TableIcon,
  TagIcon,
  TriangleAlertIcon,
  WalletIcon,
  ZapIcon,
} from "lucide-react";

type LucideIcon = typeof DatabaseIcon;

const WRITES = new Set([
  "create_budget",
  "create_layer",
  "update_budget",
  "delete_budget",
  "add_budget_items",
  "update_budget_item",
  "delete_budget_item",
  "categorise_transactions",
  "set_transaction_merchant",
]);

export function ToolIcon({ name, failed }: { name: string; failed: boolean }) {
  if (failed) return <TriangleAlertIcon className="size-3.5 shrink-0 text-status-critical" />;

  const exact: Record<string, LucideIcon> = {
    get_uncategorised_transactions: InboxIcon,
    search_transactions: SearchIcon,
    list_accounts: WalletIcon,
    list_spending_areas: ListIcon,
  };
  const ExactIcon = exact[name];
  if (ExactIcon) return <ExactIcon className="size-3.5 shrink-0" />;

  if (name.startsWith("get_transaction")) return <TableIcon className="size-3.5 shrink-0" />;
  if (/label/.test(name)) return <TagIcon className="size-3.5 shrink-0" />;
  if (/rule/.test(name)) return <ZapIcon className="size-3.5 shrink-0" />;
  if (WRITES.has(name)) return <PencilIcon className="size-3.5 shrink-0" />;
  return <DatabaseIcon className="size-3.5 shrink-0" />;
}
