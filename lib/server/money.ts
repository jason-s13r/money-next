import type { Prisma } from "../generated/prisma/client";

// The boundary between how money is *stored* and how it is *used*.
//
// Money columns are `Decimal @db.Decimal(19, 4)`, so Postgres sums them exactly —
// that is where float error would otherwise accumulate. Prisma hands those
// columns back as decimal.js objects, and they stop here: everything above the
// read layer (metrics, FX conversion, chart scales, formatting) does float
// arithmetic on plain numbers, which is fine because it was always approximate
// and ends at `formatMoney`.
//
// Converting here is not just tidiness. A decimal.js instance is a class object,
// so it cannot cross the RSC serialization boundary — handing a raw row to a
// client component or returning one from a server action throws at runtime, not
// at compile time. Every read path must go through these helpers.

/** A `Decimal` column that cannot be null. */
export function money(value: Prisma.Decimal): number {
  return value.toNumber();
}

/** A nullable `Decimal` column; null survives as null. */
export function moneyOrNull(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/** A `_sum` aggregate, which Prisma leaves null when it summed no rows. */
export function moneySum(value: Prisma.Decimal | null): number {
  return value === null ? 0 : value.toNumber();
}

/** The money columns on a `Transaction`, converted in place. */
export function transactionMoney<
  T extends {
    amount: Prisma.Decimal;
    balance: Prisma.Decimal | null;
    conversionAmount: Prisma.Decimal | null;
  },
>(row: T): Omit<T, "amount" | "balance" | "conversionAmount"> & {
  amount: number;
  balance: number | null;
  conversionAmount: number | null;
} {
  return {
    ...row,
    amount: money(row.amount),
    balance: moneyOrNull(row.balance),
    conversionAmount: moneyOrNull(row.conversionAmount),
  };
}

/** The money columns on a `PendingTransaction` (no `balance`), converted in place. */
export function pendingMoney<
  T extends { amount: Prisma.Decimal; conversionAmount: Prisma.Decimal | null },
>(row: T): Omit<T, "amount" | "conversionAmount"> & {
  amount: number;
  conversionAmount: number | null;
} {
  return {
    ...row,
    amount: money(row.amount),
    conversionAmount: moneyOrNull(row.conversionAmount),
  };
}

/** The balance columns on an `Account`, converted in place. */
export function accountMoney<
  T extends {
    balanceCurrent: Prisma.Decimal | null;
    balanceAvailable: Prisma.Decimal | null;
    balanceLimit: Prisma.Decimal | null;
  },
>(row: T): Omit<T, "balanceCurrent" | "balanceAvailable" | "balanceLimit"> & {
  balanceCurrent: number | null;
  balanceAvailable: number | null;
  balanceLimit: number | null;
} {
  return {
    ...row,
    balanceCurrent: moneyOrNull(row.balanceCurrent),
    balanceAvailable: moneyOrNull(row.balanceAvailable),
    balanceLimit: moneyOrNull(row.balanceLimit),
  };
}

/** The balance columns on a `BalanceSnapshot`, converted in place. */
export function snapshotMoney<
  T extends {
    current: Prisma.Decimal;
    available: Prisma.Decimal | null;
    limit: Prisma.Decimal | null;
  },
>(row: T): Omit<T, "current" | "available" | "limit"> & {
  current: number;
  available: number | null;
  limit: number | null;
} {
  return {
    ...row,
    current: money(row.current),
    available: moneyOrNull(row.available),
    limit: moneyOrNull(row.limit),
  };
}
