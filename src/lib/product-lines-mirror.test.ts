import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { productLines } from "./catalogue";

/**
 * ONE RULE, TWO RUNTIMES, and nothing else can check it.
 *
 * Which line leads on a product row is decided in `lib/catalogue.ts` for the CRM
 * and in `mbos-app/src/lib/product-lines.ts` for the handset. They CANNOT import
 * from each other — the handset is a separate Expo package that `tsconfig.json`
 * excludes — so the only thing joining them is that somebody copied one into the
 * other, which is exactly the kind of join that drifts silently. Both compile
 * alone, both lint alone, and the failure is a telecaller and a salesman reading
 * one product two different ways.
 *
 * The comparison is over the BODY rather than the whole file: the prose above
 * each copy is written for its own reader and is meant to differ, and quoting
 * the office's file in the handset's comment is worth more than a byte-identical
 * header. What may not differ is a single line of the arithmetic.
 */
function body(source: string): string {
  const start = source.indexOf("export function productLines(");
  assert.notEqual(start, -1, "productLines is not where this test expects it");
  const open = source.indexOf("{", source.indexOf("): {", start) + 4);
  const end = source.indexOf("\n}", open);
  assert.notEqual(end, -1, "could not find the end of productLines");
  return (
    source
      .slice(open, end)
      /* Quote style is the one thing the two files legitimately disagree on —
         the office is on double quotes and the handset on single — so it is
         normalised rather than being a reason to fail. */
      .replace(/'/g, '"')
      /* Comments inside the body are prose too. */
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

test("the handset decides a product row exactly as the office does", () => {
  const office = body(readFileSync("src/lib/catalogue.ts", "utf8"));
  const handset = body(readFileSync("mbos-app/src/lib/product-lines.ts", "utf8"));
  assert.equal(handset, office);
});

/*
 * AND THE SHAPE IS PINNED HERE TOO, so a change that keeps the two copies
 * identical and breaks them both together still fails something. A mirror test
 * alone proves agreement, never correctness.
 */
test("the formulation leads and the SKU is never lost", () => {
  const row = productLines({ displayName: "Nano Thinner - 20 Liter (Loose)", subtitle: "Nano" });
  assert.equal(row.lead, "Nano");
  assert.equal(row.detail, "Nano Thinner - 20 Liter (Loose)");
});
