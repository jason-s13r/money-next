import type { ReactNode } from "react";

export const Scroller = ({ children }: { children: ReactNode }) => (
  <div className="overflow-x-auto text-xs">{children}</div>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-xs text-muted-foreground">{children}</p>
);

export const Raw = ({ value }: { value: unknown }) => (
  <pre className="max-h-64 overflow-auto font-mono text-[11px] text-muted-foreground">
    {JSON.stringify(value, null, 2)}
  </pre>
);
