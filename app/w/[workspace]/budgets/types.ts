// Shared state shape for the budget forms, so the client components can import
// it without pulling in the server action module (and its database imports).

export type BudgetActionState = { error: string | null };

export const NO_ERROR: BudgetActionState = { error: null };

/** Which way a budget item's money goes. The stored `amount` is signed — this is
 *  only how the form asks, so nobody has to type a minus sign. */
export const DIRECTIONS = ["expense", "income"] as const;
export type Direction = (typeof DIRECTIONS)[number];
