import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  descriptionTokens,
  prefilterTokens,
  SIMILAR_THRESHOLD,
  tokenOverlap,
} from "../lib/server/matching/tokens";

/**
 * The rule that decides which transactions look like one another.
 *
 * Two of these are ordinary unit tests. The third is not: `prefilterTokens` makes
 * a *guarantee* — that narrowing the search to those tokens cannot drop anything
 * the scoring would have accepted — and the detail page's query is built on it
 * being true. If it is ever false the failure is silent and one-directional: the
 * similar-transactions list quietly stops offering a match it used to, and nobody
 * finds out, because the missing row looks exactly like a row that was never
 * similar. So the property is checked by brute force below rather than by
 * example.
 */

describe("descriptionTokens", () => {
  test("splits on whitespace and #, keeping internal punctuation", () => {
    assert.deepEqual(
      [...descriptionTokens("PAYMENT 012-345-678 #REF")],
      ["payment", "012-345-678", "ref"],
    );
  });

  test("drops a token carrying an unbroken run of four or more digits", () => {
    // A per-transaction reference or batch id: it changes every instance, so it
    // only ever lowers the overlap between two instances of the same payment.
    const tokens = descriptionTokens("SALARY d783879600 ACME LTD");
    assert.deepEqual([...tokens], ["salary", "acme", "ltd"]);
  });

  test("keeps a dashed account number, whose groups are only three digits", () => {
    assert.ok(descriptionTokens("TFR 012-345-678").has("012-345-678"));
  });

  test("trims leading and trailing punctuation but not the middle", () => {
    assert.deepEqual([...descriptionTokens("(acme), co-op.")], ["acme", "co-op"]);
  });

  test("is a set, so a repeated word counts once", () => {
    assert.equal(descriptionTokens("fee fee fee").size, 1);
  });
});

describe("tokenOverlap", () => {
  const of = (...words: string[]) => new Set(words);

  test("identical sets are 1", () => {
    assert.equal(tokenOverlap(of("a", "b"), of("a", "b")), 1);
  });

  test("disjoint sets are 0", () => {
    assert.equal(tokenOverlap(of("a"), of("b")), 0);
  });

  test("an empty set never matches anything, including another empty one", () => {
    // Rather than 0/0. A description that tokenised away entirely is unknown, not
    // identical to every other unknown one.
    assert.equal(tokenOverlap(of(), of("a")), 0);
    assert.equal(tokenOverlap(of(), of()), 0);
  });

  test("is the shared count over the union, not over either side", () => {
    // Two shared of four distinct: 2/4, not 2/3.
    assert.equal(tokenOverlap(of("a", "b", "c"), of("a", "b", "d")), 0.5);
  });

  test("is symmetric", () => {
    const a = of("acme", "ltd", "salary");
    const b = of("acme", "salary");
    assert.equal(tokenOverlap(a, b), tokenOverlap(b, a));
  });

  test("the same recurring payment under a changed reference still scores high", () => {
    // The case the whole feature exists for: the reference is dropped at
    // tokenisation, so what is left is identical.
    const a = descriptionTokens("DIRECT CREDIT payrollref778213004411#ACME PAYROLL 012-345-678");
    const b = descriptionTokens("DIRECT CREDIT payrollref778213009988# ACME PAYROLL 012-345-678");
    assert.equal(tokenOverlap(a, b), 1);
  });
});

describe("prefilterTokens", () => {
  test("takes more than half the tokens, longest first", () => {
    const tokens = new Set(["a", "bbbb", "cc", "ddddd"]);
    // Four tokens → ⌊4/2⌋ + 1 = 3, taken longest first for the trigram index.
    assert.deepEqual(prefilterTokens(tokens), ["ddddd", "bbbb", "cc"]);
  });

  test("a single token is required outright", () => {
    assert.deepEqual(prefilterTokens(new Set(["acme"])), ["acme"]);
  });

  test("both tokens, when there are two", () => {
    // ⌊2/2⌋ + 1 = 2. Asking for only one would miss a candidate sharing the other.
    assert.equal(prefilterTokens(new Set(["acme", "ltd"])).length, 2);
  });

  test("an empty description prefilters to nothing to look for", () => {
    assert.deepEqual(prefilterTokens(new Set()), []);
  });

  test("the guarantee: nothing above the threshold is filtered out", () => {
    // Brute force over every subset pair up to a workable size. For each source
    // set and each candidate set, if the candidate scores at or above the
    // threshold then it must contain one of the prefilter tokens — otherwise the
    // SQL narrowing in `getSimilarTransactions` would have thrown away a row the
    // scoring wanted to keep.
    const universe = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff"];
    const subsets: string[][] = [[]];
    for (const token of universe) {
      for (const existing of [...subsets]) subsets.push([...existing, token]);
    }

    let checked = 0;
    let qualifying = 0;
    for (const source of subsets) {
      if (source.length === 0) continue;
      const sourceTokens = new Set(source);
      const probes = new Set(prefilterTokens(sourceTokens));

      for (const candidate of subsets) {
        const candidateTokens = new Set(candidate);
        checked++;
        if (tokenOverlap(sourceTokens, candidateTokens) < SIMILAR_THRESHOLD) continue;
        qualifying++;
        const reachable = [...candidateTokens].some((token) => probes.has(token));
        assert.ok(
          reachable,
          `{${source}} vs {${candidate}} scores ` +
            `${tokenOverlap(sourceTokens, candidateTokens)} but shares none of ` +
            `the prefilter {${[...probes]}}`,
        );
      }
    }

    // Guard against the assertion above being vacuous: if a refactor made nothing
    // qualify, every case would "pass" without testing anything.
    assert.ok(checked > 3000, `expected a broad sweep, checked ${checked}`);
    assert.ok(qualifying > 100, `expected many qualifying pairs, saw ${qualifying}`);
  });

  test("the guarantee holds for real descriptions too", () => {
    const source = descriptionTokens("DIRECT CREDIT ACME PAYROLL LTD 012-345-678 WAGES");
    const probes = new Set(prefilterTokens(source));

    const candidates = [
      "DIRECT CREDIT ACME PAYROLL LTD 012-345-678 WAGES",
      "DIRECT CREDIT ACME PAYROLL LTD 012-345-678 BONUS",
      "ACME PAYROLL LTD WAGES 012-345-678",
      "DIRECT DEBIT POWER CO 12-3456-7890123-00",
      "EFTPOS SUPERMARKET",
    ];

    for (const text of candidates) {
      const tokens = descriptionTokens(text);
      if (tokenOverlap(source, tokens) < SIMILAR_THRESHOLD) continue;
      assert.ok(
        [...tokens].some((token) => probes.has(token)),
        `"${text}" is similar but the prefilter would not have found it`,
      );
    }
  });
});
