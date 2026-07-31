import { isRecord } from "./utils";
import { Raw } from "./primitives";
import { Transactions } from "./renderers/transactions";
import { Clusters } from "./renderers/clusters";
import { Areas } from "./renderers/areas";
import { BudgetItems, WrittenItems } from "./renderers/budget-items";
import { Accounts } from "./renderers/accounts";
import { Labels } from "./renderers/labels";
import { Rules, RulePreview } from "./renderers/rules";

export function ResultBody({ name, result }: { name: string; result: unknown }) {
  if (!isRecord(result)) return <Raw value={result} />;

  if (typeof result.error === "string") {
    return (
      <div className="space-y-1 text-xs">
        <p className="text-status-critical">{result.error}</p>
        <Raw value={{ ...result, error: undefined }} />
      </div>
    );
  }

  switch (name) {
    case "get_transactions":
      return <Transactions result={result} />;
    case "search_transactions":
      return <Transactions result={result} withCategory />;
    case "get_uncategorised_transactions":
      return isRecord(result.groups) ? (
        <Clusters groups={result.groups} />
      ) : (
        <Transactions result={result} />
      );
    case "list_spending_areas":
      return <Areas result={result} />;
    case "get_budget":
      return <BudgetItems result={result} />;
    case "list_accounts":
      return <Accounts result={result} />;
    case "create_budget":
    case "add_budget_items":
      return <WrittenItems result={result} />;
    case "list_labels":
      return <Labels result={result} />;
    case "list_rules":
      return <Rules result={result} />;
    case "preview_rule":
    case "create_rule":
      return <RulePreview result={result} />;
    default:
      return <Raw value={result} />;
  }
}
