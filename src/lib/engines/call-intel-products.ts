import type { ProductMatch } from "./call-intel-decide";

/* ---------------------------------------------------------------------------
 * "NANO" IS FIVE SKUS. Which one did they mean?
 *
 * The model hears a product the way a customer names it — "nano", "PU sealer
 * 20 litre", "wahi thinner" — and the catalogue search turns that into rows.
 * This decides whether those rows are ONE answer or a question.
 *
 * What this customer has bought before is the strongest evidence there is: a
 * shop that has only ever taken the 20-litre Nano and says "nano" means the
 * 20-litre Nano. Beyond that, one row is an answer and several are a
 * question, with the candidates as buttons. It never picks among several on
 * the strength of a search ranking — an order for the wrong pack is a return
 * trip for a lorry.
 *
 * PURE. The search has already happened; this only reads its rows.
 * ------------------------------------------------------------------------- */

export type SearchRow = {
  productId: string;
  name: string;
  boughtBefore: boolean;
};

const MAX_OPTIONS = 4;

export function chooseProduct(said: string, rows: SearchRow[]): ProductMatch {
  if (!rows.length) return { state: "none" };
  const q = said.trim().toLowerCase();

  const exact = rows.filter((r) => r.name.toLowerCase() === q);
  if (exact.length === 1) return matched(exact[0]);

  const bought = rows.filter((r) => r.boughtBefore);
  if (bought.length === 1) return matched(bought[0]);
  if (bought.length > 1) return ambiguous(bought);

  if (rows.length === 1) return matched(rows[0]);
  return ambiguous(rows);
}

function matched(r: SearchRow): ProductMatch {
  return { state: "matched", productId: r.productId, name: r.name };
}

function ambiguous(rows: SearchRow[]): ProductMatch {
  return {
    state: "ambiguous",
    options: rows
      .slice(0, MAX_OPTIONS)
      .map((r) => ({ productId: r.productId, name: r.name })),
  };
}
