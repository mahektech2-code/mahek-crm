/* ---------------------------------------------------------------------------
 * WHAT A TABLE RESERVES, AGAINST WHAT ITS COLUMNS ASK FOR.
 *
 * `Table` renders `table-fixed`, which does exactly what it says: the declared
 * column widths are the layout, and where they do not fit inside `minWidth`
 * the browser shrinks them to make them fit. Nothing errors and nothing looks
 * broken — the columns simply come out narrower than the number beside them
 * says, and the text inside them truncates a word or two early. On ten tables
 * in this suite they were over-subscribed by between 20 and 200 pixels.
 *
 * It is invisible at every other layer. TypeScript sees two independent
 * numbers, the lint sees valid JSX, and a screenshot at one width looks fine
 * because truncation is what these cells do anyway. So it is read off the
 * source, the way the timezone rules and the wire contract are — see
 * `table-widths.test.ts`.
 *
 * This file is the PARSER only, so the rule can be tested. It is deliberately
 * text-based rather than a change to the component's API: giving `Table` a
 * column-definition object would be the tidier answer and a refactor of 77
 * call sites, which is a different piece of work with a different risk.
 * ------------------------------------------------------------------------- */

export type TableDecl = {
  /** Where it is, for the failure message. */
  where: string;
  minWidth: number;
  /** The sum of the columns that named a width. */
  fixed: number;
  columns: number;
};

/** Every `<Table …>…</Table>` in one file, matched by depth rather than by a
 *  lazy regex — these nest, because a drawer inside a row can hold one. */
function blocks(text: string): { body: string; at: number }[] {
  const out: { body: string; at: number }[] = [];
  const opens = [...text.matchAll(/<Table\b/g)];
  for (const m of opens) {
    const start = m.index!;
    let depth = 0;
    let i = start;
    while (i < text.length) {
      if (text.startsWith("<Table", i)) {
        depth += 1;
        i += 6;
      } else if (text.startsWith("</Table>", i)) {
        depth -= 1;
        i += 8;
        if (depth === 0) {
          out.push({ body: text.slice(start, i), at: start });
          break;
        }
      } else {
        i += 1;
      }
    }
  }
  return out;
}

/**
 * A width is declared two ways in this codebase and both count: as a prop on
 * `HeadCell`/`SortHead`, and as the third argument of the local `head()`
 * helper most of these screens define. Reading only the first would pass every
 * screen that uses the second, which is most of the Lead Management ones.
 */
export function tableDeclarations(source: string, file: string): TableDecl[] {
  const out: TableDecl[] = [];
  for (const { body, at } of blocks(source)) {
    const mw = /minWidth=\{(\d+)\}/.exec(body);
    if (!mw) continue;
    const headAt = body.indexOf("head={");
    if (headAt === -1) continue;
    const headEnd = body.indexOf("\n    >", headAt);
    const head = body.slice(headAt, headEnd === -1 ? undefined : headEnd);
    const widths = [
      ...[...head.matchAll(/width=\{(\d+)\}/g)].map((m) => Number(m[1])),
      ...[...head.matchAll(/head\(\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*(\d+)/g)].map((m) =>
        Number(m[1]),
      ),
    ];
    if (widths.length === 0) continue;
    out.push({
      where: `${file}:${source.slice(0, at).split("\n").length}`,
      minWidth: Number(mw[1]),
      fixed: widths.reduce((a, b) => a + b, 0),
      columns: widths.length,
    });
  }
  return out;
}
