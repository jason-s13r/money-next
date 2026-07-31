import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// Rendering what the model wrote.
//
// Two constraints shape this more than taste does.
//
// **No raw HTML.** `rehype-raw` is deliberately absent, so HTML in a reply is escaped
// and shown as text rather than parsed. The model is quoting a household's own
// transaction descriptions back at them — strings that came off a bank feed and have
// never been sanitised anywhere — and there is no version of "render whatever it says"
// that is worth the trouble it invites.
//
// **No remote images.** The CSP (`proxy.ts`) allows `img-src 'self' data:
// https://cdn.akahu.nz`, so an image from anywhere else is blocked by the browser and
// renders as a broken icon. Better to show the alt text and say what it was.
//
// Tables get the app's own table primitives rather than bare `<table>`, because a
// model asked to summarise spending answers with tables constantly and they should
// look like the rest of the app's.

const components: Components = {
  // Prose spacing is set here rather than with a typography plugin: the app does not
  // have one, and a handful of margins is cheaper than adding it for one surface.
  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,

  code: ({ className, children }) => {
    // react-markdown gives a fenced block a `language-*` class and an inline span
    // none, which is the only way to tell them apart here.
    const fenced = /language-/.test(className ?? "");
    if (!fenced) {
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
      );
    }
    return (
      <code className="block overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="mb-3 last:mb-0">{children}</pre>,

  // Wide tables scroll inside their own box; the page never scrolls sideways.
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <Table>{children}</Table>
    </div>
  ),
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableHead>{children}</TableHead>,
  td: ({ children }) => <TableCell className="tabular-nums">{children}</TableCell>,

  // Same-origin links navigate; anything else opens away and is marked as leaving.
  a: ({ href, children }) => {
    const external = !!href && /^https?:\/\//.test(href);
    return (
      <a
        href={href}
        className="text-primary underline underline-offset-4"
        {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      >
        {children}
      </a>
    );
  },

  img: ({ alt }) => (
    <span className="text-sm text-muted-foreground">[image: {alt || "untitled"}]</span>
  ),
};

/**
 * @param className overrides the wrapper's size and colour — reasoning is rendered
 *   smaller and greyer than an answer, and is the same markdown either way. Merged with
 *   `cn`, so a `text-xs` here beats the `text-sm` default rather than fighting it.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-sm", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
