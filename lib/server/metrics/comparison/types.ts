// Shared types for the period comparison metrics.

/** Counted, but Akahu named no category. Rendered in the de-emphasis grey. */
export const UNCATEGORISED = "Uncategorised";
/** A merchant the enrichment never named. Kept as a row so its money stays visible. */
export const UNKNOWN_MERCHANT = "Unknown";

/**
 * One subcategory row, and the merchants beneath it. `total` equals the sum of
 * `merchants`; it is stored rather than recomputed so the caller reads it once.
 */
export type SpendDetail = {
  total: number;
  merchants: Map<string, number>;
};

export type PeriodBreakdown = {
  key: string;
  spend: Map<string, number>;
  /**
   * What each spending row is made of, keyed by the row above it: a category
   * breaks down into its subcategories, and each of those into its merchants.
   * The values sum to the row above.
   */
  spendDetail: Map<string, Map<string, SpendDetail>>;
  /**
   * Income broken into its NZFCC subcategories (Wages, Refunds…), and each of
   * those into the merchants beneath — the income source. Inflows nothing named
   * fall under "Uncategorised" so the totals sum to `incomeTotal`.
   */
  incomeDetail: Map<string, SpendDetail>;
  incomeTotal: number;
  spendTotal: number;
  /** Still in progress. Its totals are not comparable with a full period's. */
  partial: boolean;
};

/** Income − spending. Overstated wherever a transfer is counted as either. */
export function netOf(p: PeriodBreakdown): number {
  return p.incomeTotal - p.spendTotal;
}

export type Comparison = {
  period: import("../../../periods").Period;
  periods: PeriodBreakdown[];
  /** Stable slot order, computed over the whole window so a category keeps its
   *  colour from one period to the next. Colour follows the entity, not its rank
   *  within a single bar. */
  spendCategories: string[];
  /**
   * The income subcategories (Wages, Refunds…), ranked over the whole window so
   * each keeps its place — and its colour — from one period to the next. This is
   * the flat list that colours the bar and legend; the table groups these under
   * their income group (see `incomeGroups`/`incomeGroupOf`).
   */
  incomeSubcategories: string[];
  /** The income groups present ("Periodic Income", "Other Income"), in that fixed
   *  order — the collapsible parent rows the table groups subcategories under. */
  incomeGroups: string[];
  /** Which income group each subcategory belongs to, so the table can nest it.
   *  Null only for a subcategory whose rows carry no group at all. */
  incomeGroupOf: Map<string, string | null>;
  /** Merchants beneath each income subcategory, ranked. Empty until a source is
   *  named — an all-unnamed level would only restate the row above it. */
  incomeMerchants: Map<string, string[]>;
  /**
   * Disclosure rows for each spending category, ranked over the whole window so a
   * subcategory keeps its place from one period to the next.
   */
  spendSubcategories: Map<string, string[]>;
  /** The same, one level down: category → subcategory → merchants, ranked. */
  spendMerchants: Map<string, Map<string, string[]>>;
  /** A representative merchant id for each merchant name shown, so the chart's
   *  merchant rows link to the id-keyed merchant page. Absent for the unnamed
   *  bucket; where a name spans several ids, any one — the link opens that id. */
  merchantIds: Map<string, string>;
  /** The logo URL for each merchant name shown, taken from the transaction's own
   *  `logo` when present, otherwise looked up from the Merchant table. Absent for
   *  the unnamed bucket. */
  merchantLogos: Map<string, string>;
  /** One axis shared by every bar in every period, so lengths are comparable
   *  both within a period and across them. */
  max: number;
  /**
   * How far the partial period's data actually reaches — the most recent
   * transaction, not today. A sync that ran an hour ago and a sync that ran last
   * week produce the same calendar month; only this tells them apart.
   * Null when the period in progress holds no transactions yet.
   */
  through: Date | null;
  /** Whether income/spending data exists in a period older than this window —
   *  i.e. whether paging further back would show anything. */
  hasOlder: boolean;
};
