import "server-only";
import { cache } from "react";

import { getDb } from "../db/request";
import { taxYearFor } from "../tax-year";
import type { TaxYear } from "../../periods";

// The current workspace's tax year, for a page.
//
// A breakdown page needs it before it has any metrics: `?from=` is snapped to a
// window with `offsetForStartDate`, and a tax-year window cannot be resolved
// without knowing where the year starts. Memoised so the four pages that each ask
// twice — once to parse the window, once to page it — read one row between them.
//
// The worker-side counterpart is `taxYearFor`, which takes its client as an
// argument because it has no request to memoise against. This is the request's
// meeting point with it, like `queries/` generally. The metrics builders call
// that one directly and pay their own read: they run detached from any request
// (a chat turn), where this file's `cache` would have nothing to hang on.

export const getTaxYear = cache(async (): Promise<TaxYear> => taxYearFor(await getDb()));
