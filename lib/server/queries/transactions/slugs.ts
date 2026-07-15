import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { db } from "../../db";

// The slug resolvers that let an unknown key 404: each returns the distinct set
// of values on record for a listing dimension (type, card suffix, category name),
// so a route can check the slug it was handed against what actually exists.

/** The transaction types on record, for resolving a slug back and 404ing unknowns. */
export const getTransactionTypes = cache(async () => {
  await connection();
  const rows = await db.transaction.findMany({
    distinct: ["type"],
    orderBy: { type: "asc" },
    select: { type: true },
  });
  return rows.map((row) => row.type);
});

/** The card suffixes on record, so an unknown one 404s instead of listing nothing. */
export const getCardSuffixes = cache(async () => {
  await connection();
  const rows = await db.transaction.findMany({
    where: { cardSuffix: { not: null } },
    distinct: ["cardSuffix"],
    select: { cardSuffix: true },
  });
  return rows.map((row) => row.cardSuffix!);
});

/** The category names a group actually holds, for resolving a slug back. */
export const getCategoryNames = cache(async (group: string) => {
  await connection();
  const rows = await db.transaction.findMany({
    where: { categoryGroup: { is: { name: group } }, categoryId: { not: null } },
    distinct: ["categoryId"],
    select: { category: { select: { name: true } } },
  });
  return rows.map((row) => row.category!.name);
});
