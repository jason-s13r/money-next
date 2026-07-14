// Shared types for the rules actions. Kept out of the `"use server"` module so a
// client component can import them without pulling a server action into its
// bundle (and so the action file exports only async functions, as required).

export type GenerateRuleResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      merged: boolean;
      expression: string;
      tokens: string[];
      categoryName: string | null;
      merchantName: string | null;
      /** How many stored transactions the new predicate matches, so the user can
       *  sanity-check its reach before it runs on future syncs. */
      matchCount: number;
    };
