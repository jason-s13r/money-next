// Cash-flow classification: is a transaction real income, real spending, or just
// money moving between accounts you already own?
//
// Without this, every derived number is wrong. A naive `SUM(amount) WHERE
// amount > 0` counts a sweep account's churn and self-transfers between your own
// banks as income, and can overstate it by more than 2x.
//
// The ladder below never guesses. A row it cannot justify becomes UNCATEGORIZED
// and surfaces in the review queue, rather than being silently folded into a
// number someone will trust. That property is the whole point: when the
// classifier fails, it fails visibly.
//
// This module is pure — no database, no clock, and no personal data. The rules
// that name your banks, your employer, or you are injected as `Rules`; see
// `lib/classify-rules.ts`.

export type Flow = "INCOME" | "EXPENSE" | "INTERNAL" | "REFUND" | "UNCATEGORIZED";

/**
 * How a verdict was reached.
 *
 * `merchant` means the inflow named a business we pay elsewhere — inferred from
 * the data, not from a rule someone wrote. `default` means we fell back to the
 * sign of the amount: the money is real and counted, but *which* bucket it
 * belongs to was inferred rather than established. Those rows are the review
 * queue.
 */
export type FlowSource = "override" | "pair" | "rule" | "merchant" | "default";

export type ClassifiableTransaction = {
  id: string;
  accountId: string;
  date: Date;
  description: string;
  amount: number;
  type: string;
  categoryGroup: string | null;
  merchantName: string | null;
};

export type Verdict = {
  flow: Flow;
  flowSource: FlowSource;
  /** Shared by the two legs of a matched internal transfer. */
  transferId: string | null;
  /** Only set on INCOME. Ours, not Akahu's — inflows arrive uncategorised. */
  incomeCategory: string | null;
};

/**
 * The personal half of the classifier. Everything here is specific to one
 * person's accounts and payers, so it is loaded from a gitignored file rather
 * than committed.
 */
export type Rules = {
  /**
   * Descriptions that mean "I moved my own money". Match exact phrases, never
   * loose ones: a bank puts the account holder's name on both a self-transfer
   * and an incoming salary, so a bare surname pattern will quietly reclassify
   * income as internal movement and inflate the savings rate.
   */
  internalDescriptions: RegExp[];
  /**
   * Money coming back, not money earned: an insurance claim, a merchant refund,
   * an overpayment returned. Counting these as income overstates both what you
   * earn and what you save.
   */
  refundDescriptions: RegExp[];
  /**
   * Payer patterns, in order, mapped to an income category. This is a list of
   * claims about who pays you, and it is the part of the classifier that goes
   * stale. A payer that matches nothing still counts as income — it just lands
   * in the "Uncategorised" bucket and shows up in the review queue.
   */
  incomeRules: { pattern: RegExp; category: string }[];
};

/** Transfers settle on different days at different banks. */
const PAIR_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Wise records one conversion as two rows with different wording:
 *   `Converted 1,000.00 USD to 1,700.00 NZD for NZD balance`
 *   `Converted 1,000.00 USD from USD balance to 1,700.00 NZD`
 * Anchoring the tail misses both. Match the head only.
 */
const FX_CONVERSION = /^Converted [\d,.]+ [A-Z]{3} /i;

/** Bank types that are internal movement by definition. */
const INTERNAL_TYPES = new Set(["TRANSFER", "LOAN"]);

/** Standing orders carry the same `AP#…` reference on both legs. */
function referenceToken(description: string): string | null {
  return description.match(/\bAP#(\d+)\b/)?.[1] ?? null;
}

/**
 * Short merchant names are worthless as substrings. `BP`, `Z`, `One`, `Next`,
 * and `Wise` appear inside ordinary bank wording and would match nearly every
 * description. Five characters is the floor at which a name identifies a
 * business rather than a coincidence.
 */
const MIN_MERCHANT_NAME = 5;

const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ");

/**
 * Businesses we pay. Akahu enriches debits only, so an inflow never carries a
 * merchant of its own — but the merchants on our *outflows* tell us who they are.
 * Money arriving from a business you buy from is a refund, not earnings.
 */
function knownMerchants(transactions: ClassifiableTransaction[]): string[] {
  const names = new Set<string>();
  for (const tx of transactions) {
    if (!tx.merchantName) continue;
    const name = normalise(tx.merchantName).trim();
    if (name.length >= MIN_MERCHANT_NAME) names.add(name);
  }
  // Longest first, so `Southern Cross` wins over a hypothetical `Southern`.
  return [...names].sort((a, b) => b.length - a.length);
}

/** Money is stored as float; compare in integer cents. */
const cents = (amount: number) => Math.round(amount * 100);

/**
 * Match each outflow to an equal, opposite inflow on a *different* account
 * within a few days. Structural, and independent of how the bank labelled it.
 *
 * Greedy and one-to-one, nearest date gap first. Ties are deliberately left
 * unpaired: two separate standing orders of the same amount can credit the same
 * account on the same day, and picking either at random would silently
 * reclassify a real payment as internal movement.
 *
 * Runs twice — first keyed on the shared `AP#` reference, which disambiguates
 * exactly that case, then on amount and date alone for everything else.
 */
function pairTransfers(
  transactions: ClassifiableTransaction[],
  excluded: ReadonlySet<string>,
): { transfers: Map<string, string>; ambiguous: number } {
  const transfers = new Map<string, string>();
  const used = new Set<string>(excluded);
  let ambiguous = 0;

  const gap = (a: ClassifiableTransaction, b: ClassifiableTransaction) =>
    Math.abs(a.date.getTime() - b.date.getTime());

  const runPass = (keyOf: (tx: ClassifiableTransaction) => string | null) => {
    const inflows = new Map<string, ClassifiableTransaction[]>();
    for (const tx of transactions) {
      if (tx.amount <= 0 || used.has(tx.id)) continue;
      const key = keyOf(tx);
      if (key === null) continue;
      if (!inflows.has(key)) inflows.set(key, []);
      inflows.get(key)!.push(tx);
    }

    for (const out of transactions) {
      if (out.amount >= 0 || used.has(out.id)) continue;
      const key = keyOf(out);
      if (key === null) continue;

      const candidates = (inflows.get(key) ?? [])
        .filter(
          (i) => !used.has(i.id) && i.accountId !== out.accountId && gap(i, out) <= PAIR_WINDOW_MS,
        )
        .sort((a, b) => gap(a, out) - gap(b, out));

      if (candidates.length === 0) continue;
      if (candidates.length > 1 && gap(candidates[0], out) === gap(candidates[1], out)) {
        ambiguous++;
        continue;
      }

      const inflow = candidates[0];
      used.add(out.id);
      used.add(inflow.id);
      const transferId = `xfer_${out.id}`;
      transfers.set(out.id, transferId);
      transfers.set(inflow.id, transferId);
    }
  };

  runPass((tx) => {
    const token = referenceToken(tx.description);
    return token && `ref:${token}:${Math.abs(cents(tx.amount))}`;
  });
  runPass((tx) => `amt:${Math.abs(cents(tx.amount))}`);

  return { transfers, ambiguous };
}

export type ClassificationResult = {
  verdicts: Map<string, Verdict>;
  ambiguousPairs: number;
};

/**
 * @param overrides Human corrections, keyed by transaction id. Always win, and
 *   are never recomputed — the only place a person's judgement is stored.
 */
export function classify(
  transactions: ClassifiableTransaction[],
  overrides: ReadonlyMap<string, Flow>,
  rules: Rules,
): ClassificationResult {
  const verdicts = new Map<string, Verdict>();
  const incomeCategoryFor = (description: string) =>
    rules.incomeRules.find((rule) => rule.pattern.test(description))?.category ?? null;

  const merchants = knownMerchants(transactions);
  const merchantFor = (description: string) => {
    const haystack = normalise(description);
    return merchants.find((name) => haystack.includes(name)) ?? null;
  };

  // Level 1: overrides. Excluded from pairing, so a human "this is income"
  // cannot be consumed as the leg of some other transfer.
  for (const tx of transactions) {
    const flow = overrides.get(tx.id);
    if (!flow) continue;
    verdicts.set(tx.id, {
      flow,
      flowSource: "override",
      transferId: null,
      incomeCategory: flow === "INCOME" ? incomeCategoryFor(tx.description) : null,
    });
  }

  // Level 2: structural pairing.
  //
  // An inflow a rule positively recognises — a benefit payment, an insurance
  // claim, a payer we know — is shielded from pairing. Amount-and-date matching
  // is blind to meaning, and a $400 tax credit will happily pair with a $400
  // payment three days later and vanish into "internal transfer".
  const internalByRule = (tx: ClassifiableTransaction) =>
    INTERNAL_TYPES.has(tx.type) ||
    FX_CONVERSION.test(tx.description) ||
    rules.internalDescriptions.some((re) => re.test(tx.description));

  const shielded = new Set(verdicts.keys());
  for (const tx of transactions) {
    if (tx.amount <= 0 || internalByRule(tx)) continue;
    const recognised =
      rules.refundDescriptions.some((re) => re.test(tx.description)) ||
      merchantFor(tx.description) !== null ||
      incomeCategoryFor(tx.description) !== null;
    if (recognised) shielded.add(tx.id);
  }

  const { transfers, ambiguous } = pairTransfers(transactions, shielded);
  for (const [id, transferId] of transfers) {
    verdicts.set(id, { flow: "INTERNAL", flowSource: "pair", transferId, incomeCategory: null });
  }

  // Level 3: rules.
  for (const tx of transactions) {
    if (verdicts.has(tx.id)) continue;

    if (internalByRule(tx)) {
      verdicts.set(tx.id, {
        flow: "INTERNAL",
        flowSource: "rule",
        transferId: null,
        incomeCategory: null,
      });
      continue;
    }

    // A refund is money returning, not money earned. Checked before the income
    // rules so an insurance reimbursement never counts as a payer.
    if (tx.amount > 0 && rules.refundDescriptions.some((re) => re.test(tx.description))) {
      verdicts.set(tx.id, {
        flow: "REFUND",
        flowSource: "rule",
        transferId: null,
        incomeCategory: null,
      });
      continue;
    }

    // A named payer beats a merchant substring. If you are ever employed by a
    // business you also buy from, your salary must not become a refund.
    if (tx.amount > 0) {
      const category = incomeCategoryFor(tx.description);
      if (category) {
        verdicts.set(tx.id, {
          flow: "INCOME",
          flowSource: "rule",
          transferId: null,
          incomeCategory: category,
        });
        continue;
      }
    }

    // Money arriving from a business we buy from. Recorded as `merchant` rather
    // than `rule` because it is inferred from the merchants on our own spending,
    // and because the inference is not airtight: proceeds from *selling* through
    // a marketplace look exactly like a refund from it.
    if (tx.amount > 0 && merchantFor(tx.description)) {
      verdicts.set(tx.id, {
        flow: "REFUND",
        flowSource: "merchant",
        transferId: null,
        incomeCategory: null,
      });
      continue;
    }

    // Akahu enriched it against a real merchant. NZFCC assigns a
    // `personal_finance` group to spending categories only, so a group is
    // positive evidence that money left for goods, not a lucky heuristic.
    if (tx.amount < 0 && (tx.categoryGroup !== null || tx.merchantName !== null)) {
      verdicts.set(tx.id, {
        flow: "EXPENSE",
        flowSource: "rule",
        transferId: null,
        incomeCategory: null,
      });
    }
  }

  // Level 4: fall back to the sign of the amount.
  //
  // Once paired transfers, internal rules, and refunds are out of the way, money
  // arriving really is income of some kind and money leaving really is spending
  // — an unrecognised payer is still a payer. Holding these in limbo hid real
  // income from the dashboard.
  //
  // What is inferred is the *bucket*, not the money, so `flowSource` records it
  // as a default. Everything downstream can still ask "how much of this total
  // did we actually establish?" — the review queue, and the uncertainty band on
  // every net figure, are both built from that question.
  for (const tx of transactions) {
    if (verdicts.has(tx.id)) continue;

    if (tx.amount === 0) {
      verdicts.set(tx.id, {
        flow: "UNCATEGORIZED",
        flowSource: "default",
        transferId: null,
        incomeCategory: null,
      });
      continue;
    }

    verdicts.set(tx.id, {
      flow: tx.amount > 0 ? "INCOME" : "EXPENSE",
      flowSource: "default",
      transferId: null,
      incomeCategory: null,
    });
  }

  return { verdicts, ambiguousPairs: ambiguous };
}
