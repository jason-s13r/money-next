"use client";

import Image from "next/image";

import { Link } from "@/ui/chrome/workspace-context";
import { LabelsCell } from "@/ui/transactions/labels-cell";
import type { TransactionListItem } from "@/lib/server/queries/transactions";
import { formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";

// The panel a row opens to. The listing now shows only the essentials as columns
// (a two-line description carrying the date/category, and the amount with its
// running balance); everything else lives here, one click away, so the table
// reads cleanly on a narrow screen. Laid out as two aligned rows — the row's
// identity, then its raw bank metadata — followed by the editable labels and a
// link to the full detail page (history, transfers, similar…).

const link = "underline underline-offset-2";
const dash = <span className="opacity-40">—</span>;

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs opacity-60">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

export function TransactionRowDetails({ tx }: { tx: TransactionListItem }) {
  return (
    <div className="space-y-4 px-3 py-4 text-sm">
      {/* Line 1: what the row is and where it lives. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {/* The raw statement text, which the description column no longer shows
            once a merchant or transfer summary stands in for it. */}
        <Detail label="Description">{tx.description}</Detail>
        <Detail label="Account">
          <span className="flex items-center gap-2">
            {tx.account.connection?.logo ? (
              <Image
                src={tx.account.connection.logo}
                alt=""
                width={20}
                height={20}
                loading="lazy"
                decoding="async"
                className="h-5 w-5 rounded object-contain"
              />
            ) : null}
            <Link href={`/accounts/${tx.account.id}`} className={link}>
              {tx.account.name}
            </Link>
          </span>
        </Detail>
        <Detail label="Card">
          {tx.cardSuffix ? (
            <Link href={`/card/${tx.cardSuffix}`} className={link}>
              ····{tx.cardSuffix}
            </Link>
          ) : (
            dash
          )}
        </Detail>
        <Detail label="Type">
          <Link href={`/transactions/type/${slugify(tx.type)}`} className={link}>
            {tx.type}
          </Link>
        </Detail>
      </dl>

      {/* Line 2: the raw bank metadata, on its own row. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Detail label="Particulars">{tx.particulars || dash}</Detail>
        <Detail label="Code">{tx.code || dash}</Detail>
        <Detail label="Reference">{tx.reference || dash}</Detail>
        <Detail label="Other account">
          {tx.otherAccount ? <span className="font-mono">{tx.otherAccount}</span> : dash}
        </Detail>
      </dl>

      {/* Foreign-currency conversion, when Akahu's meta carried one: the original
          amount in its own currency and the rate applied to reach the account's
          currency. Shown only for the rows that actually have it. */}
      {tx.conversionAmount !== null ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Detail label="Original amount">
            {formatMoney(tx.conversionAmount, tx.conversionCurrency)}
          </Detail>
          {tx.conversionRate !== null ? (
            <Detail label="Exchange rate">{tx.conversionRate}</Detail>
          ) : null}
        </dl>
      ) : null}

      {/* Line 3: the editable labels. */}
      <div>
        <dt className="text-xs opacity-60">Labels</dt>
        <dd className="mt-1">
          <LabelsCell transactionId={tx.id} labels={tx.labels.map((l) => l.label)} />
        </dd>
      </div>

      <div>
        <Link href={`/transactions/${tx.id}`} className={`text-xs ${link}`}>
          View full details →
        </Link>
      </div>
    </div>
  );
}
