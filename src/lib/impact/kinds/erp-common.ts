import "server-only";
import { ErpNotPermitted, requireErpForm, type ErpContext } from "@/lib/erp/access";

/* ---------------------------------------------------------------------------
 * WHO MAY READ AN ERP DELETE'S IMPACT: whoever may open the screen the delete
 * sits on AND would be allowed to press it. The modal lists lots, parties and
 * stock — a person who cannot open the screen must not be able to read those
 * by asking what a delete would touch. A preview ("view as") may read it, as
 * it may open the screen; the act itself still refuses while previewing.
 * ------------------------------------------------------------------------- */

/**
 * Throws unless the signed-in person holds one of `screens` and, where given,
 * `allowed` answers no refusal for them — the same words the act refuses in.
 */
export async function erpMayDelete(
  screens: string[],
  allowed?: (ctx: ErpContext) => string | null,
): Promise<ErpContext> {
  let last: unknown = new ErpNotPermitted("That screen is not on your account.");
  for (const screen of screens) {
    try {
      const ctx = await requireErpForm(screen);
      const refusal = allowed?.(ctx) ?? null;
      if (refusal) throw new ErpNotPermitted(refusal);
      return ctx;
    } catch (e) {
      last = e;
      if (e instanceof ErpNotPermitted && e.message !== "That screen is not on your account.") throw e;
    }
  }
  throw last;
}

/** A number as the ERP's screens print it: whole where whole, three places at most. */
export function qty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** "1 can" / "3 cans". */
export const many = (n: number, one: string, more = `${one}s`) => (n === 1 ? one : more);

/**
 * Only the groups that hold something. The registry keeps a "kept" group at
 * zero, because a kept group can be a statement ("the video on YouTube stays")
 * — but "Stays as it is: other lines of the recipe" over a recipe with no other
 * lines reads as though there were some, so a source drops its empty ones.
 */
export function present<T extends { count: number }>(items: T[]): T[] {
  return items.filter((i) => i.count > 0);
}
