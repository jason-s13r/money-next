"use client";

import { useTransition } from "react";
import { FilterIcon, Loader2Icon, RefreshCwIcon, type LucideIcon } from "lucide-react";

import { useCanEdit } from "@/ui/chrome/workspace-context";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { refreshAndSync } from "./actions";
import { applyRulesNow } from "./rules/actions";

// The two global "enqueue a batch" data actions — trigger a sync, or apply the
// active rules across all history. Each used to be a one-off primary button on
// its own page (/sync, /rules); hoisted into the app header so they're reachable
// from anywhere. Each wears its own page's nav icon so the header button and the
// destination read as the same thing. Both are edit-only (a viewer carries
// neither `sync.run` nor `enrichment.update`), so the whole group hides for
// viewers.
export function DataActions() {
  const canEdit = useCanEdit();
  if (!canEdit) return null;

  return (
    <div className="flex items-center gap-0.5">
      <ActionButton label="Sync" icon={RefreshCwIcon} action={refreshAndSync} />
      <ActionButton label="Apply rules" icon={FilterIcon} action={applyRulesNow} />
    </div>
  );
}

function ActionButton({
  label,
  icon: Icon,
  action,
}: {
  label: string;
  icon: LucideIcon;
  action: () => Promise<unknown>;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <form action={() => startTransition(async () => void (await action()))}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button type="submit" variant="ghost" size="icon-sm" disabled={isPending} aria-label={label}>
              {isPending ? <Loader2Icon className="animate-spin" /> : <Icon />}
            </Button>
          }
        />
        <TooltipContent>{isPending ? "Queuing…" : label}</TooltipContent>
      </Tooltip>
    </form>
  );
}
