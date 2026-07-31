import { LayoutDashboardIcon } from "lucide-react";
import {
  ArrowRightLeftIcon,
  FilterIcon,
  InboxIcon,
  PieChartIcon,
  RefreshCwIcon,
  StoreIcon,
  TagIcon,
  TargetIcon,
  WalletIcon,
  WaypointsIcon,
} from "lucide-react";

import { MessageSparklesIcon } from "@/ui/chrome/icons";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboardIcon };
type NavSection = { label?: string; items: NavItem[] };

// The nav is a flat list of labelled sections, always expanded — no collapsing.
// A section with no `label` is an unlabelled cluster of top-level destinations;
// a labelled one heads its items with a muted section label. Every item carries
// an icon so the icon-collapsed rail still reads.
export const nav: NavSection[] = [
  {
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
      { href: "/accounts", label: "Accounts", icon: WalletIcon },
      { href: "/chat", label: "Chat", icon: MessageSparklesIcon },
    ],
  },
  {
    label: "Breakdown",
    items: [
      { href: "/breakdown", label: "Income and spending", icon: PieChartIcon },
      { href: "/breakdown/flow", label: "Money Flow", icon: WaypointsIcon },
      { href: "/budgets", label: "Budgets", icon: TargetIcon },
    ],
  },
  {
    label: "Transactions",
    items: [
      { href: "/transactions/recent", label: "Recent", icon: ArrowRightLeftIcon },
      { href: "/transactions/uncategorised", label: "Uncategorised", icon: InboxIcon },
      { href: "/merchants", label: "Merchants", icon: StoreIcon },
      { href: "/labels", label: "Labels", icon: TagIcon },
    ],
  },
  {
    label: "Tasks",
    items: [
      { href: "/rules", label: "Rules", icon: FilterIcon },
      { href: "/sync", label: "Sync", icon: RefreshCwIcon },
    ],
  },
];

/** Whether `rel` is `base` itself or a path beneath it. `/` matches only itself. */
export function isUnder(rel: string, base: string) {
  return base === "/" ? rel === "/" : rel === base || rel.startsWith(`${base}/`);
}
