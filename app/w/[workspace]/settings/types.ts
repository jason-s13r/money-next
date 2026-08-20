// Shared types for the settings actions. Kept out of the `"use server"` module
// for the reason members/types.ts documents: a server module may export *only*
// async functions, so a plain constant or a type alias has to live next door.

/** What the tax year form gets back from a save. The echoed start is what the
 *  form re-renders its preview from, so a save and the label under it cannot
 *  disagree about what was stored. */
export type TaxYearResult =
  | { ok: false; reason: string }
  | { ok: true; startMonth: number; startDay: number };
