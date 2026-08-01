"use client";

import { useState } from "react";

import Image from "next/image";

import { Link } from "@/ui/chrome/workspace-context";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { DEFAULT_CURRENCY, formatMoney } from "@/lib/format";
import { positiveAmountClass } from "@/lib/ui/amount";

// The merchants index list with its "custom only" filter. A client island: the
// whole set is loaded once on the server (it is small) and the toggle filters it
// in memory, so switching is instant and needs no round-trip.

export type MerchantListItem = {
  id: string;
  name: string;
  logo: string | null;
  count: number;
  /** Net of the merchant's transactions in the display currency (spend is negative). */
  net: number;
  userCreated: boolean;
};

export function MerchantsList({ merchants }: { merchants: MerchantListItem[] }) {
  const [customOnly, setCustomOnly] = useState(false);
  const shown = customOnly ? merchants.filter((m) => m.userCreated) : merchants;

  return (
    <>
      <div className="mb-2 flex justify-end">
        <Toggle
          variant="outline"
          size="sm"
          pressed={customOnly}
          onPressedChange={setCustomOnly}
          aria-label="Show only custom merchants"
        >
          Custom only
        </Toggle>
      </div>

      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No custom merchants yet. Set a new merchant name on a transaction to
          mint one.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {shown.map((merchant) => (
            <li key={merchant.id}>
              <Link
                href={`/merchants/${merchant.id}`}
                className="flex items-center justify-between gap-3 py-3 hover:opacity-80"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {merchant.logo ? (
                    <Image
                      src={merchant.logo}
                      alt=""
                      width={24}
                      height={24}
                      loading="lazy"
                      decoding="async"
                      className="h-6 w-6 shrink-0 rounded object-contain"
                    />
                  ) : null}
                  <span className="truncate">{merchant.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-4">
                  {/* Private merchants the user typed themselves. accent, not the
                      secondary variant, whose bg/text don't pair in this theme. */}
                  {merchant.userCreated ? (
                    <Badge
                      variant="secondary"
                      className="bg-accent text-accent-foreground"
                    >
                      Custom
                    </Badge>
                  ) : null}
                  <span
                    className={`w-28 text-right font-mono text-sm tabular-nums ${positiveAmountClass(merchant.net)}`}
                  >
                    {formatMoney(merchant.net, DEFAULT_CURRENCY)}
                  </span>
                  <span className="w-14 text-right text-sm tabular-nums text-muted">
                    {merchant.count.toLocaleString("en-NZ")}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
