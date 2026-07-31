import { count, isRecord, str } from "./utils";

const LABELS: Record<string, string> = {
  list_spending_areas: "Spending areas",
  get_transactions: "Transactions",
  search_transactions: "Searched transactions",
  get_uncategorised_transactions: "Uncategorised",
  get_transaction: "Transaction",
  list_budgets: "Budgets",
  get_budget: "Budget",
  list_accounts: "Accounts",
  list_labels: "Tags",
  list_rules: "Rules",
  preview_rule: "Checked a rule",
  create_budget: "Created a budget",
  create_layer: "Created a layer",
  update_budget: "Changed a budget",
  delete_budget: "Deleted a budget",
  add_budget_items: "Added items",
  update_budget_item: "Changed an item",
  delete_budget_item: "Removed an item",
  categorise_transactions: "Categorised",
  set_transaction_merchant: "Set the payee",
  create_label: "Created a tag",
  rename_label: "Renamed a tag",
  delete_label: "Deleted a tag",
  add_label_to_transactions: "Tagged",
  remove_label_from_transactions: "Untagged",
  create_rule: "Wrote a rule",
  delete_rule: "Removed a rule",
  apply_rules: "Ran the rules",
};

export function label(name: string): string {
  return LABELS[name] ?? name;
}

export function summary(name: string, result: unknown): string {
  if (!isRecord(result)) return "";
  switch (name) {
    case "list_spending_areas":
      return `${count(result.areas)} areas`;
    case "get_transactions":
      return `${result.returned ?? 0} of ${result.matched ?? 0} in ${result.area ?? "?"}${result.more ? ", more" : ""}`;
    case "list_budgets":
      return `${count(result.budgets)} budgets`;
    case "get_budget":
      return `${result.budget ?? ""} — ${count(result.items)} items`;
    case "list_accounts":
      return `${count(result.accounts)} accounts`;
    case "create_budget":
      return `${result.budget ?? ""} — ${result.created ?? 0} items`;
    case "add_budget_items":
      return `${result.added ?? 0} added to ${result.budget ?? ""}`;
    case "update_budget_item":
      return isRecord(result.updated) ? String(result.updated.name ?? "updated") : "updated";
    case "delete_budget_item":
      return "removed";
    case "search_transactions":
      return `${result.returned ?? 0} of ${result.matched ?? 0}${result.more ? ", more" : ""}`;
    case "get_uncategorised_transactions":
      return isRecord(result.groups)
        ? `${result.matched ?? 0} in ${count((result.groups as Record<string, unknown>).similar)} groups`
        : `${result.returned ?? 0} of ${result.matched ?? 0}${result.more ? ", more" : ""}`;
    case "get_transaction":
      return `${str(result.date)} ${str(result.description).slice(0, 40)}`;
    case "list_labels":
      return `${count(result.labels)} tags`;
    case "list_rules":
      return `${count(result.rules)} rules`;
    case "preview_rule":
      return `would match ${result.matches ?? 0}`;
    case "categorise_transactions":
      return `${result.changed ?? 0} → ${str(result.category) || "no category"}`;
    case "set_transaction_merchant":
      return `${result.changed ?? 0} → ${str(result.merchant) || "no payee"}`;
    case "create_label":
    case "rename_label":
      return str(result.label);
    case "delete_label":
      return `${str(result.deleted)}, off ${result.untaggedTransactions ?? 0}`;
    case "add_label_to_transactions":
      return `${result.tagged ?? 0} tagged ${str(result.label)}`;
    case "remove_label_from_transactions":
      return `${result.untagged ?? 0} untagged`;
    case "create_rule":
      return isRecord(result.rule)
        ? `${result.merged ? "folded in" : "new"}, matches ${result.matchesNow ?? 0}`
        : "";
    case "delete_rule":
      return "removed";
    case "apply_rules":
      return "queued";
    default:
      return "";
  }
}
