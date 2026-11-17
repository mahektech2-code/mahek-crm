/* ---------------------------------------------------------------------------
 * Pure: which of a planned write's fields would actually change a row. A
 * scheduled pass that writes a row with nothing new still costs a write, a
 * fresh `updated_at` and — for customers — a re-download on every handset.
 * ------------------------------------------------------------------------- */

/**
 * The fields of `values` that differ from what the row already holds, or null
 * when none do. A field the row was not read with counts as changed — the
 * projection only sets those alongside one it did read (creditTermDays rides
 * with creditDays), so that never turns a no-op into a write.
 */
export function changedFields<T extends Record<string, unknown>>(
  values: T,
  current: Record<string, unknown>,
): Partial<T> | null {
  const out: Partial<T> = {};
  let any = false;
  for (const k of Object.keys(values) as (keyof T & string)[]) {
    const v = values[k];
    if (v === undefined) continue;
    const was = current[k];
    const same =
      k in current &&
      (v instanceof Date && was instanceof Date ? v.getTime() === was.getTime() : (v ?? null) === (was ?? null));
    if (!same) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}
