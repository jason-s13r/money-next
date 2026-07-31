import { createLucideIcon } from "lucide-react";

// Icons lucide doesn't ship, drawn in its own idiom (24x24 grid, 2px stroke) so
// they sit next to the real ones without looking pasted in.

/**
 * A speech bubble with sparkles in it — chat, but the AI kind.
 *
 * Lucide has no message/sparkles combination, so this is its `message-square`
 * outline with two four-point stars set inside. The stars are *filled* rather
 * than stroked: a stroked sparkle shrunk to fit inside the bubble loses its
 * negative space at 16px and reads as a plus sign. Their `d` is a hand-drawn
 * star rather than lucide's `sparkle` path, which is too blunt-armed to survive
 * being scaled down this far.
 */
const STAR = "M12 3q1 8 9 9-8 1-9 9-1-8-9-9 8-1 9-9z";

export const MessageSparklesIcon = createLucideIcon("message-sparkles", [
  // `key` is not decoration: lucide renders `iconNode` as an array through
  // `createElement(tag, attrs)`, so React reads each element's key off `attrs`.
  // Omit it and every render of this icon logs a missing-key warning.
  [
    "path",
    {
      d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      key: "bubble",
    },
  ],
  [
    "path",
    {
      d: STAR,
      fill: "currentColor",
      stroke: "none",
      transform: "translate(13.2 10.4) scale(0.52) translate(-12 -12)",
      key: "star",
    },
  ],
  [
    "path",
    {
      d: STAR,
      fill: "currentColor",
      stroke: "none",
      transform: "translate(8.4 13.4) scale(0.24) translate(-12 -12)",
      key: "spark",
    },
  ],
]);
