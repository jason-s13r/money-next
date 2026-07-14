// Money in (a positive amount) is tinted green wherever an amount is shown;
// money out inherits the surrounding ink colour, so spending is the quiet default
// and only a credit draws the eye. One definition so the two shades stay in step.
export const positiveAmountClass = (amount: number) =>
  amount > 0 ? "text-green-600 dark:text-green-400" : "";
