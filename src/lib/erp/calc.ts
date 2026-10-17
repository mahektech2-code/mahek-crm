/* ---------------------------------------------------------------------------
 * Named calculators for derived form fields (spec: "Derived" kind).
 *
 * A form shows what a record WILL be before it is saved — the lot number, the
 * litres, the box quantity — computed in the browser from what is typed and
 * from data the server sent with the form. The server computes the same
 * figure again on save and that is the one stored; these exist so the person
 * sees it first.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

export type CalcInput = {
  /** The header's values. */
  h: Record<string, string>;
  /** This line's values, on a line field. */
  l: Record<string, string>;
  /** All lines, for a batch-wide figure. */
  lines: Record<string, string>[];
  /** Index of this line. */
  i: number;
  /** Server-sent data the form carries. */
  data: Record<string, unknown>;
};

export type Calc = (x: CalcInput) => string;

const CALCS: Record<string, Calc> = {};

export function registerCalc(name: string, fn: Calc) {
  CALCS[name] = fn;
}

export function runCalc(name: string | undefined, x: CalcInput): string {
  if (!name) return "";
  const fn = CALCS[name];
  if (!fn) return "";
  try {
    return fn(x);
  } catch {
    return "";
  }
}

/** Parses a typed number; blank is null, garbage is NaN. */
export function n(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  return Number(v);
}

export function fmt(v: number, dp = 2): string {
  return v.toLocaleString("en-IN", { maximumFractionDigits: dp });
}
