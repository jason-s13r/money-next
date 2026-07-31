"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { ToolIcon } from "./icon";
import { label, summary } from "./label";
import { ResultBody } from "./result-body";
import { isRecord, safeParse } from "./utils";

type Props = {
  name: string;
  args: string;
  result?: unknown;
};

export function ToolCard({ name, args, result }: Props) {
  const [open, setOpen] = useState(false);
  const running = result === undefined;
  const failed = isRecord(result) && typeof result.error === "string";

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
        aria-expanded={open}
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <ToolIcon name={name} failed={failed} />
        <span className="font-medium text-foreground">{label(name)}</span>
        <span className="truncate">
          {running ? "working…" : failed ? String((result as { error: string }).error) : summary(name, result)}
        </span>
      </button>

      {open ? (
        <div className="border-t border-border px-3 py-2">
          {Object.keys(safeParse(args) ?? {}).length > 0 ? (
            <pre className="mb-2 overflow-x-auto font-mono text-[11px] text-muted-foreground">
              {args}
            </pre>
          ) : null}
          {running ? null : <ResultBody name={name} result={result} />}
        </div>
      ) : null}
    </div>
  );
}
