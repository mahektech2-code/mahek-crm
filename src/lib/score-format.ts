/**
 * A score, written down — ONE decimal, everywhere.
 *
 * Accounts printed a whole number, the Sales Dashboard and the CRM one
 * decimal, the Command Centre rounded, and the handset one decimal: 74.45 read
 * "74" on one screen and "74.5" on the next, and two people reading one man's
 * month came away with two numbers. Pure and client-safe, because half the
 * screens that print a score are client components.
 */
export function scoreText(bp: number): string {
  return (bp / 100).toFixed(1);
}
