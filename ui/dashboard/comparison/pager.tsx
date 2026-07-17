import { NavPair } from "@/ui/primitives/nav-pair";

/**
 * Shifts the six-period window through time. Time runs left-to-right — older
 * periods on the left — so "Earlier" sits on the left and "More recent" on the
 * right. Each step is three periods, so consecutive windows overlap by half and
 * a trend never breaks across a boundary.
 */
export function WindowPager({
  earlierHref,
  moreRecentHref,
}: {
  earlierHref: string | null;
  moreRecentHref: string | null;
}) {
  return (
    <NavPair
      left={{ href: earlierHref, label: "← Earlier" }}
      right={{ href: moreRecentHref, label: "More recent →" }}
    />
  );
}
