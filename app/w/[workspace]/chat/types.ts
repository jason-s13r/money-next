/** The state every chat action returns. Same shape as the rest of the app's, so a
 *  client component renders the error the same way. Lives in its own module so a
 *  `"use client"` file can import the type without pulling the database in with it. */
export type ChatActionState = { error: string | null };

export const NO_ERROR: ChatActionState = { error: null };
