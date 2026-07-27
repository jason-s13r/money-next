import "server-only";
import { connection } from "next/server";
import { cache } from "react";

import { getDb } from "../db/request";

// Reads for the forecasts page: the forecasts and the budget each projects.
//
// The *projection* — where each line goes and when it runs out — is not here.
// That lives in `lib/server/metrics/budget/forecast.ts`, because it is the same
// computation the dashboard chart runs and the two must not drift. This module
// only answers "what forecasts exist and which budget each points at", which is
// what the editor needs.

export type ForecastView = {
  id: string;
  slug: string;
  name: string;
  color: string;
  position: number;
  /** The one budget this forecast projects. */
  budgetId: string;
};

export const getForecasts = cache(async (): Promise<ForecastView[]> => {
  await connection();
  const db = await getDb();

  const rows = await db.forecast.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      color: true,
      position: true,
      budgetId: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    color: row.color,
    position: row.position,
    budgetId: row.budgetId,
  }));
});
