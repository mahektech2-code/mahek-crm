/* ---------------------------------------------------------------------------
 * The goods receipt starts from the ITEM that came off the truck, not from a
 * PO number nobody at the gate knows. This is the rule for that pick: which
 * items can be received (those with an approved PO line still open), how a
 * search ranks them, which open PO lines an item offers, and — once a delivery
 * has a vendor — the narrowing to that vendor's open lines, because one GRN is
 * one vendor's delivery.
 *
 * PURE and client-safe: the server builds the list, the record searches it, and
 * the save checks every line again against the POs as they stand.
 * ------------------------------------------------------------------------- */

/** One approved PO line still waiting for goods. */
export type GrnPoLine = {
  /** The PO's form label ("PO-9 · Dharam Chem Impex"), which the save reads back. */
  po: string;
  /** The PO line's label on that PO. */
  poLine: string;
  /** "PO-9". */
  poNumber: string;
  supplier: string;
  godown: string;
  /** ISO date the PO asks for the goods by, if it says. */
  due: string | null;
  ordered: number;
  received: number;
  pending: number;
  unit: string;
};

export type GrnItem = {
  item: string;
  type: string;
  code: string | null;
  unit: string;
  /** Open PO lines, oldest due date first. Empty: nothing can be received yet. */
  lines: GrnPoLine[];
};

/** Open lines first by due date (undated last), then by PO number. */
export function sortPoLines(lines: GrnPoLine[]): GrnPoLine[] {
  return [...lines].sort((a, b) => {
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    }
    return a.poNumber.localeCompare(b.poNumber, undefined, { numeric: true });
  });
}

/** The lines an item offers to THIS delivery: every open line, or only the named vendor's. */
export function linesFor(item: GrnItem, supplier?: string | null): GrnPoLine[] {
  return supplier ? item.lines.filter((l) => l.supplier === supplier) : item.lines;
}

const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * How well a query names an item: 3 the whole name or code, 2 the start of the
 * name or of a word in it, 1 somewhere inside, 0 not at all. Every word typed
 * has to be found.
 */
export function matchScore(item: Pick<GrnItem, "item" | "code">, query: string): number {
  const q = fold(query);
  if (!q) return 1;
  const name = fold(item.item);
  const code = item.code ? fold(item.code) : "";
  if (name === q || (code && code === q)) return 3;
  const words = q.split(" ");
  const hay = `${name} ${code}`;
  if (!words.every((w) => hay.includes(w))) return 0;
  const starts = name.startsWith(q) || (code && code.startsWith(q)) || words.every((w) => ` ${hay}`.includes(` ${w}`));
  return starts ? 2 : 1;
}

export type GrnHit = { item: GrnItem; lines: GrnPoLine[]; receivable: boolean };

/**
 * The search the first step draws. Receivable items before the rest, then by
 * how well they match, then by name. With a vendor named, an item is
 * receivable only on that vendor's open lines. Items that cannot be received
 * stay in the answer (`receivable: false`) so "not found" never means "not in
 * the list".
 */
export function searchGrnItems(items: GrnItem[], query: string, opts: { supplier?: string | null; limit?: number } = {}): GrnHit[] {
  const hits: (GrnHit & { score: number })[] = [];
  for (const item of items) {
    const score = matchScore(item, query);
    if (!score) continue;
    const lines = linesFor(item, opts.supplier);
    hits.push({ item, lines, receivable: lines.length > 0, score });
  }
  hits.sort((a, b) => Number(b.receivable) - Number(a.receivable) || b.score - a.score || a.item.item.localeCompare(b.item.item));
  return hits.slice(0, opts.limit ?? 30).map((h) => ({ item: h.item, lines: h.lines, receivable: h.receivable }));
}

/** "2 open POs · 1,400 kg pending · Dharam Chem Impex, Shree Ganesh Chemical". */
export function hitSummary(lines: GrnPoLine[], nf: (n: number) => string): string {
  if (!lines.length) return "No PO is waiting for this item";
  const pos = new Set(lines.map((l) => l.po)).size;
  const pending = lines.reduce((a, l) => a + l.pending, 0);
  const vendors = [...new Set(lines.map((l) => l.supplier))].join(", ");
  return `${pos} open PO${pos === 1 ? "" : "s"} · ${nf(pending)} ${lines[0].unit} pending · ${vendors}`;
}
