import { z } from "zod";

import { getDb } from "@/lib/server/db/request";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { isFrequency } from "@/lib/budget/recurrence";
import { parseForm, text } from "@/lib/form-data";

/** The most repeat intervals a budget item may span. A year is the ceiling because
 *  no recurring commitment runs less often than once a year, and the recurrence
 *  module's own range tops out there too. */
const MAX_INTERVAL = 365;

/**
 * A `YYYY-MM-DD` from a date input, as UTC midnight.
 *
 * UTC midnight is the representation the recurrence module uses for an NZ
 * calendar day throughout: NZ leads UTC by 12–13 hours, so UTC midnight always
 * resolves back to the same NZ day. Parsing the parts rather than handing the
 * string to `new Date` keeps that explicit instead of relying on the spec's
 * date-only rule.
 */
export function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February and friends, which `Date.UTC` would silently roll over.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/** The dashboard draws from budgets, so a change to which base a layer belongs to
 *  (or a duplicate that lands on a base) makes its projected lines stale. */
export async function revalidateDashboard() {
  await revalidateWorkspacePath("/");
}

/** The lifespan columns from a budget form, or a message saying what is wrong. */
export function readLifespan(form: FormData): { error: string } | {
  startsOn: Date | null;
  endsOn: Date | null;
  repeatsAnnually: boolean;
} {
  // "always" is the general daily-living budget: no bounds at all.
  if (text(form, "lifespan") !== "window") {
    return { startsOn: null, endsOn: null, repeatsAnnually: false };
  }

  const startsOn = parseDay(text(form, "startsOn"));
  const endsOn = parseDay(text(form, "endsOn"));
  if (!startsOn || !endsOn) {
    return { error: "A budget with a window needs both a start and an end date." };
  }

  const repeatsAnnually = form.get("repeatsAnnually") === "on";
  // A window that runs backwards is almost always a typo — except when it repeats
  // annually, where start-after-end is exactly how a window that wraps the New
  // Year is written (15 Dec – 5 Jan), and rejecting it would forbid the single
  // most obvious seasonal budget there is.
  if (!repeatsAnnually && endsOn < startsOn) {
    return { error: "The end date is before the start date." };
  }

  return { startsOn, endsOn, repeatsAnnually };
}

/**
 * The item form's shape, in the order the form reads down the page.
 *
 * The order matters: `parseForm` surfaces the first issue, so a page with two
 * things wrong reports the higher one — which is the one the reader's eye is
 * already on. Every entry carries its own message, because Zod's defaults
 * ("Invalid option: expected one of …") are machine voice and every other string
 * a household sees here is not.
 *
 * Module scope rather than rebuilt per call: nothing in it varies by request,
 * and `readItem` runs on every item create and update.
 */
const ITEM_SHAPE = {
  name: z.string().min(1, "Give the item a name."),
  amount: z
    .string()
    .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, "Enter an amount greater than zero.")
    .transform(Number),
  // The form asks for a direction and a positive figure; the sign is applied
  // below, so `amount` is stored signed like `Transaction.amount` and nobody has
  // to type a minus.
  direction: z
    .string()
    .refine((v) => v === "income" || v === "expense", "Choose whether this is money in or money out."),
  frequency: z.string().refine(isFrequency, "Choose how often this happens."),
  interval: z
    .string()
    .refine(
      (v) => {
        const n = Number(v || "1");
        return Number.isInteger(n) && n >= 1 && n <= MAX_INTERVAL;
      },
      `The repeat interval must be a whole number between 1 and ${MAX_INTERVAL}.`,
    )
    .transform((v) => Number(v || "1")),
  anchorDate: z
    .string()
    .refine((v) => parseDay(v) !== null, "Choose the date this happens on.")
    .transform((v) => parseDay(v)!),
  categoryGroupId: z.string().min(1, "Choose a category group."),
  // Both optional: `""` from an unset select means "not filed against one",
  // which is why they are plain strings here and narrowed to `null` below rather
  // than being given a `.min(1)`.
  categoryId: z.string(),
  merchantId: z.string(),
};

/**
 * Validate an item form against what this workspace can actually see.
 *
 * Shape first (formats, ranges, the either/or), then the id lookups — because
 * every id is resolved through the scoped client rather than taken at face
 * value. The category group and category come from shared catalogs so the check
 * is only that they exist; the merchant is half tenant data, and `scopedDb`'s
 * merchant filter is what stops one workspace filing a budget item against
 * another's private merchant.
 */
export async function readItem(form: FormData): Promise<{ error: string } | {
  name: string;
  amount: number;
  categoryGroupId: string;
  categoryId: string | null;
  merchantId: string | null;
  frequency: string;
  interval: number;
  anchorDate: Date;
}> {
  const db = await getDb();

  const parsed = parseForm(form, ITEM_SHAPE);
  if ("error" in parsed) return parsed;

  const { name, amount: magnitude, direction, frequency, interval, anchorDate, categoryGroupId } = parsed.data;
  const amount = direction === "income" ? magnitude : -magnitude;

  const categoryId = parsed.data.categoryId || null;
  const merchantId = parsed.data.merchantId || null;

  // The three existence checks are independent — run them in parallel and check
  // the results in priority order (group, then category, then merchant) so the
  // error messages stay consistent regardless of which query finishes first.
  const [group, category, merchant] = await Promise.all([
    db.categoryGroup.findUnique({ where: { id: categoryGroupId }, select: { id: true } }),
    categoryId ? db.category.findUnique({ where: { id: categoryId }, select: { id: true } }) : Promise.resolve(null),
    merchantId ? db.merchant.findUnique({ where: { id: merchantId }, select: { id: true } }) : Promise.resolve(null),
  ]);

  if (!group) return { error: "That category group no longer exists." };
  if (categoryId && !category) return { error: "That category no longer exists." };
  if (merchantId && !merchant) return { error: "That merchant no longer exists." };

  return { name, amount, categoryGroupId, categoryId, merchantId, frequency, interval, anchorDate };
}
