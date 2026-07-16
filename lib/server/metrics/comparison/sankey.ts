// Sankey data adapter: turn a Comparison window into nodes and weighted links.
//
// A Sankey here is read as a flow of money, left to right: who paid you, what
// that income was, which groups it went out through, what it was spent on, and
// who finally received it. A "Savings" node absorbs a surplus on the right, or
// funds a deficit from the left, so the two sides balance.
//
// The adapter is pure: it knows nothing about SVG layout. It only names nodes,
// assigns them stable ids and colours, and emits links with values that sum
// correctly. The vocabulary it works in — the columns, the node shape, the
// bucket labels, the two column orders — is shared with the layout and so lives
// in @/lib/sankey.

import "server-only";

import type { Comparison } from "./types";
import { UNKNOWN_MERCHANT } from "./types";
import { slotColor } from "@/lib/server/metrics/comparison-nodes";
import {
  DEPTH,
  OTHER_EXPENSES,
  OTHER_INCOME,
  OTHER_SOURCES,
  SAVINGS,
  compareIncome,
  compareSpendGroup,
  type SankeyData,
  type SankeyLink,
  type SankeyNode,
} from "@/lib/sankey";

/** A real (category, subcategory) pair in the source data, before any folding. */
type SubcategoryRef = { category: string; label: string };

/** Thresholds for folding small nodes into synthetic "Other" buckets. */
const INCOME_THRESHOLD = 0.05;
const INCOME_MERCHANT_THRESHOLD = 0.025;
const PER_CATEGORY_THRESHOLD = 0.05;
const RIGHT_COLUMN_THRESHOLD = 0.015;
const MIDDLE_COLUMN_THRESHOLD = 0.018;
const MERCHANT_THRESHOLD = 0.025;

/** A safe id that won't collide across depths or labels. */
function idFor(depth: number, label: string, parent?: string): string {
  return parent ? `${depth}:${parent}>${label}` : `${depth}:${label}`;
}

/**
 * The money pipeline, left to right. See {@link DEPTH} for the columns.
 *
 * Each column folds whatever is too small to name into a synthetic bucket, so
 * the diagram stays legible: "Other Income" on the income side, "Other {group}"
 * and "Other expenses" through the middle. Those buckets are not dead ends — each
 * remembers the real rows it stands for and goes on to name their merchants like
 * any other node.
 *
 * The last column is the exception: a merchant too small to name is dropped, not
 * bucketed, so the spend subcategories are the one place where less money leaves a
 * node than entered it. See the `bucketLabel: null` call below.
 *
 * "Savings" balances the period: a surplus flows into it on the right, a deficit
 * is funded by it from the left.
 */
export function flowSankey(comparison: Comparison, periodIndex: number): SankeyData {
  const {
    periods,
    incomeSubcategories,
    incomeGroupOf,
    spendCategories,
    spendSubcategories,
  } = comparison;
  const period = periods[periodIndex];
  if (!period) return { nodes: [], links: [] };

  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  let middleOtherExpensesValue = 0;

  const addNode = (depth: number, label: string, value: number, color: string, parent: string | null) => {
    const id = idFor(depth, label, parent ?? undefined);
    nodes.push({ id, label, depth, value, color, parent });
    return id;
  };

  /**
   * Build one of the two merchant columns. Both ends of the diagram pose the
   * same problem — sum each merchant across the nodes it trades with and name the
   * ones big enough to be worth a row — so they share this. Only the direction of
   * the links differs: income merchants feed their node, spend merchants are fed
   * by it, and each side decides for itself what becomes of the remainder.
   */
  const buildMerchantColumn = ({
    depth,
    bucketLabel,
    thresholdRatio,
    perNodeMerchants,
    inbound,
  }: {
    depth: number;
    /**
     * Where the merchants too small to name go. A label gathers them into one
     * bucket; null drops them from the diagram, leaving the node they came from
     * with more money entering than leaves it.
     */
    bucketLabel: string | null;
    thresholdRatio: number;
    /** Node id → the merchants beneath it, already summed per merchant. */
    perNodeMerchants: Map<string, Map<string, number>>;
    /** True when merchants pay into the node, false when the node pays them. */
    inbound: boolean;
  }) => {
    const colorOfNode = new Map(nodes.map((n) => [n.id, n.color]));
    const totals = new Map<string, number>();
    const colors = new Map<string, string>();
    const bestContribution = new Map<string, number>();

    for (const [nodeId, merchants] of perNodeMerchants) {
      const nodeColor = colorOfNode.get(nodeId) ?? "var(--text-muted)";
      for (const [merchant, value] of merchants) {
        totals.set(merchant, (totals.get(merchant) ?? 0) + value);
        // Colour follows the single largest contributor, not the running total —
        // otherwise a later, bigger contributor loses to the sum of earlier ones.
        if (value > (bestContribution.get(merchant) ?? 0)) {
          bestContribution.set(merchant, value);
          colors.set(merchant, nodeColor);
        }
      }
    }

    const columnTotal = [...totals.values()].reduce((sum, v) => sum + v, 0);
    const threshold = columnTotal > 0 ? columnTotal * thresholdRatio : 0;
    // A merchant nobody named can't be a row of its own, whatever it's worth.
    const named = (merchant: string) =>
      merchant !== UNKNOWN_MERCHANT && (totals.get(merchant) ?? 0) >= threshold;

    for (const [merchant, total] of totals) {
      if (named(merchant)) {
        addNode(depth, merchant, total, colors.get(merchant) ?? "var(--text-muted)", null);
      }
    }

    if (bucketLabel) {
      let bucketValue = 0;
      for (const merchants of perNodeMerchants.values()) {
        for (const [merchant, value] of merchants) {
          if (!named(merchant)) bucketValue += value;
        }
      }
      if (bucketValue > 0) addNode(depth, bucketLabel, bucketValue, "var(--text-muted)", null);
    }

    const link = (nodeId: string, merchantId: string, value: number) =>
      links.push(inbound ? { source: merchantId, target: nodeId, value } : { source: nodeId, target: merchantId, value });

    for (const [nodeId, merchants] of perNodeMerchants) {
      let bucketShare = 0;
      for (const [merchant, value] of merchants) {
        if (named(merchant)) link(nodeId, idFor(depth, merchant), value);
        else bucketShare += value;
      }
      if (bucketLabel && bucketShare > 0) link(nodeId, idFor(depth, bucketLabel), bucketShare);
    }
  };

  // --- Column 1: income subcategories ---
  // Each node remembers the real subcategories it stands for, so the merchant
  // column to its left can name them even for the folded "Other Income" bucket.
  const incomeTotal = period.incomeTotal;
  const threshold = incomeTotal > 0 ? incomeTotal * INCOME_THRESHOLD : 0;
  let otherIncomeValue = 0;
  const otherIncomeSources: string[] = [];
  const incomeSourcesByNodeId = new Map<string, string[]>();

  for (const label of incomeSubcategories) {
    const detail = period.incomeDetail.get(label);
    if (!detail || detail.total <= 0) continue;
    const group = incomeGroupOf.get(label) ?? null;
    if (detail.total < threshold) {
      otherIncomeValue += detail.total;
      otherIncomeSources.push(label);
    } else {
      const id = addNode(DEPTH.incomeSubcategory, label, detail.total, slotColor(incomeSubcategories, label), group);
      incomeSourcesByNodeId.set(id, [label]);
    }
  }

  if (otherIncomeValue > 0) {
    const id = addNode(DEPTH.incomeSubcategory, OTHER_INCOME, otherIncomeValue, "var(--text-muted)", null);
    incomeSourcesByNodeId.set(id, otherIncomeSources);
  }

  // --- Column 0: income merchants — who the money actually came from ---
  const incomeMerchantsByNode = new Map<string, Map<string, number>>();
  for (const [nodeId, sources] of incomeSourcesByNodeId) {
    const perMerchant = new Map<string, number>();
    for (const label of sources) {
      for (const [merchant, value] of period.incomeDetail.get(label)?.merchants ?? []) {
        if (value > 0) perMerchant.set(merchant, (perMerchant.get(merchant) ?? 0) + value);
      }
    }
    if (perMerchant.size > 0) incomeMerchantsByNode.set(nodeId, perMerchant);
  }

  buildMerchantColumn({
    depth: DEPTH.incomeMerchant,
    bucketLabel: OTHER_SOURCES,
    thresholdRatio: INCOME_MERCHANT_THRESHOLD,
    perNodeMerchants: incomeMerchantsByNode,
    inbound: true,
  });

  // --- Column 2: expense category groups ---
  // Compute total first so we can fold small groups into a middle "Other expenses".
  const rawGroupValues = new Map<string, number>();
  let middleColumnTotal = 0;
  for (const category of spendCategories) {
    const value = period.spend.get(category) ?? 0;
    if (value > 0) {
      rawGroupValues.set(category, value);
      middleColumnTotal += value;
    }
  }

  const middleThreshold = middleColumnTotal > 0 ? middleColumnTotal * MIDDLE_COLUMN_THRESHOLD : 0;
  const largeGroups: string[] = [];

  for (const [category, value] of rawGroupValues) {
    if (value < middleThreshold) {
      // Folded, and that is the end of it — a group too small to name here is not
      // broken down further, so nothing needs to remember which ones these were.
      middleOtherExpensesValue += value;
    } else {
      largeGroups.push(category);
      addNode(DEPTH.spendGroup, category, value, slotColor(spendCategories, category), null);
    }
  }

  if (middleOtherExpensesValue > 0) {
    addNode(DEPTH.spendGroup, OTHER_EXPENSES, middleOtherExpensesValue, "var(--text-muted)", null);
  }

  // --- Column 3: expense subcategories ---
  // Pre-compute the global right-column threshold from all raw subcategory
  // values so that per-category folding can capture anything small enough to
  // be folded globally. This ensures the per-category "Other {group}" bucket
  // is the recipient instead of the global "Other expenses" node.
  let rawRightColumnTotal = 0;
  for (const category of largeGroups) {
    const subMap = period.spendDetail.get(category);
    for (const label of spendSubcategories.get(category) ?? []) {
      const detail = subMap?.get(label);
      if (detail && detail.total > 0) {
        rawRightColumnTotal += detail.total;
      }
    }
  }
  const minFoldThreshold = rawRightColumnTotal > 0 ? rawRightColumnTotal * RIGHT_COLUMN_THRESHOLD : 0;

  // First pass: collect candidates with per-category folding that also
  // captures anything below the right-column threshold.
  //
  // Every candidate carries the real subcategories it stands for. A plain
  // subcategory stands for itself; an "Other {group}" bucket stands for all the
  // ones folded into it. That provenance is what lets a synthetic bucket go on
  // to name its merchants instead of dead-ending in the middle of the diagram.
  type Candidate = { label: string; value: number; parent: string | null; sources: SubcategoryRef[] };
  const candidates: Candidate[] = [];

  for (const category of largeGroups) {
    const groupTotal = period.spend.get(category) ?? 0;
    if (groupTotal <= 0) continue;

    const subMap = period.spendDetail.get(category);
    const catThreshold = groupTotal * PER_CATEGORY_THRESHOLD;
    const foldThreshold = Math.max(catThreshold, minFoldThreshold);
    let otherValue = 0;
    const otherSources: SubcategoryRef[] = [];

    for (const label of spendSubcategories.get(category) ?? []) {
      const detail = subMap?.get(label);
      if (!detail || detail.total <= 0) continue;
      if (detail.total < foldThreshold) {
        otherValue += detail.total;
        otherSources.push({ category, label });
      } else {
        candidates.push({ label, value: detail.total, parent: category, sources: [{ category, label }] });
      }
    }

    if (otherValue > 0) {
      candidates.push({ label: `Other ${category}`, value: otherValue, parent: category, sources: otherSources });
    }
  }

  // Every candidate stands as its own node — there is no second pass, because
  // there is no global "Other expenses" left to fold into. A scoped remainder
  // says something ("the rest of Household"); a cross-group pile of Household
  // crumbs and Lifestyle crumbs says only "miscellaneous". So an "Other {group}"
  // bucket keeps its own row however small it is, rather than being folded a
  // second time into a heap that names nothing.
  /** The real subcategories each emitted subcategory node speaks for. */
  const sourcesByNodeId = new Map<string, SubcategoryRef[]>();

  for (const c of candidates) {
    const color = c.parent ? slotColor(spendCategories, c.parent) : "var(--text-muted)";
    sourcesByNodeId.set(addNode(DEPTH.spendSubcategory, c.label, c.value, color, c.parent), c.sources);
  }

  // --- Column 4: merchants — who finally received the money ---
  // Read the merchants straight off the detail, as the income column does, rather
  // than through `Comparison.spendMerchants`. That list is ranked for the table's
  // disclosure rows, and withholds itself entirely when a subcategory's merchants
  // are all unnamed — a sensible rule for a reveal that would restate the row
  // above, and the wrong one here: it would drop that subcategory's spend out of
  // the diagram, leaving the node with money coming in and none going out.
  const spendMerchantsByNode = new Map<string, Map<string, number>>();
  for (const [subId, sources] of sourcesByNodeId) {
    // A bucket can gather the same merchant from several folded subcategories,
    // so sum per merchant first — one link per pair, not one per source.
    const perMerchant = new Map<string, number>();
    for (const { category, label } of sources) {
      for (const [merchant, value] of period.spendDetail.get(category)?.get(label)?.merchants ?? []) {
        if (value > 0) perMerchant.set(merchant, (perMerchant.get(merchant) ?? 0) + value);
      }
    }
    if (perMerchant.size > 0) spendMerchantsByNode.set(subId, perMerchant);
  }

  buildMerchantColumn({
    depth: DEPTH.spendMerchant,
    // No bucket: a merchant too small to name is left out rather than gathered
    // into an "Other Merchants" row. This is the one place the diagram stops
    // conserving — a subcategory's rect stands for its whole value while only its
    // named merchants leave it, so the uncovered part of the rect is the money
    // going somewhere unnamed. It has been between a sixth and two thirds of this
    // column, so the gap is not a rounding artefact; it is most of some months.
    bucketLabel: null,
    thresholdRatio: MERCHANT_THRESHOLD,
    perNodeMerchants: spendMerchantsByNode,
    inbound: false,
  });

  // --- Balance node: Savings ---
  const net = period.incomeTotal - period.spendTotal;
  let savingsId: string | null = null;

  if (net < 0) {
    // Deficit: Savings funds the shortfall, so it stands with the income.
    savingsId = addNode(DEPTH.incomeSubcategory, SAVINGS, -net, "var(--text-muted)", null);
  }

  // --- Links: income subcategories → expense category groups ---
  // Greedy allocation: send each income node to the largest expense group that
  // still has remaining capacity. This minimizes the number of outgoing links
  // per income node (often to just one target) while keeping the diagram
  // readable.
  // Both sides are ordered exactly as the diagram will stack them, so the
  // greedy pass hands the topmost income to the topmost spend and the links run
  // flat instead of crossing.
  const incomeNodes = nodes.filter((n) => n.depth === DEPTH.incomeSubcategory).toSorted(compareIncome);
  const spendGroupNodes = nodes.filter((n) => n.depth === DEPTH.spendGroup).toSorted(compareSpendGroup);

  const incomeRemaining = new Map<string, number>();

  if (incomeNodes.length > 0) {
    const remaining = new Map<string, number>();
    for (const tgt of spendGroupNodes) {
      remaining.set(tgt.id, tgt.value);
    }

    for (const src of incomeNodes) {
      let srcRemaining = src.value;
      for (const tgt of spendGroupNodes) {
        if (srcRemaining <= 0) break;
        const tgtRemaining = remaining.get(tgt.id) ?? 0;
        if (tgtRemaining <= 0) continue;
        const value = Math.min(srcRemaining, tgtRemaining);
        if (value > 0) {
          links.push({ source: src.id, target: tgt.id, value });
          remaining.set(tgt.id, tgtRemaining - value);
          srcRemaining -= value;
        }
      }
      incomeRemaining.set(src.id, srcRemaining);
    }
  }

  // Surplus: create Savings on the right and send unallocated income to it
  if (net > 0) {
    savingsId = addNode(DEPTH.spendSubcategory, SAVINGS, net, "var(--text-muted)", null);
    for (const src of incomeNodes) {
      const remaining = incomeRemaining.get(src.id) ?? 0;
      if (remaining > 0) {
        links.push({ source: src.id, target: savingsId, value: remaining });
      }
    }
  }

  // --- Links: expense category groups → subcategories ---
  // The group column's "Other expenses" used to pass its whole value down one
  // link into a node of the same name in the column to its right. That node is
  // gone, so this one now ends the flow where it stands: the groups beneath it
  // were too small to name, and their subcategories would be smaller still.
  const middleOtherExpensesId = idFor(DEPTH.spendGroup, OTHER_EXPENSES);

  const subNodesByParent = new Map<string, SankeyNode[]>();
  for (const n of nodes) {
    if (n.depth !== DEPTH.spendSubcategory || !n.parent) continue;
    const siblings = subNodesByParent.get(n.parent);
    if (siblings) siblings.push(n);
    else subNodesByParent.set(n.parent, [n]);
  }

  for (const categoryNode of spendGroupNodes) {
    // Skip the middle "Other expenses" node — it has no subcategories
    if (categoryNode.id === middleOtherExpensesId) continue;

    for (const sub of subNodesByParent.get(categoryNode.label) ?? []) {
      links.push({ source: categoryNode.id, target: sub.id, value: sub.value });
    }
  }

  // Remove any zero-value nodes and links that reference them
  const validNodeIds = new Set(
    nodes.filter((n) => n.value > 0).map((n) => n.id),
  );
  const filteredNodes = nodes.filter((n) => validNodeIds.has(n.id));
  const filteredLinks = links.filter(
    (l) => validNodeIds.has(l.source) && validNodeIds.has(l.target) && l.value > 0,
  );

  return { nodes: filteredNodes, links: filteredLinks };
}
