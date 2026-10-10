import { test } from "node:test";
import assert from "node:assert/strict";
import type { ColSpec } from "@/lib/erp/ui";
import { CHECK_COL, essentialKeys, fitColumns, minWidth } from "./fit-columns";

const col = (k: string, t: ColSpec["t"], l = k): ColSpec => ({ k, l, t });

/* The order-details list as the server declares it: 26 columns. */
const WIDE: ColSpec[] = [
  col("follow", "s", "Transport follow-up"),
  col("date", "d", "Order date"),
  col("no", "mono", "Order no"),
  col("party", "b", "Billing party"),
  ...Array.from({ length: 20 }, (_, i) => col(`x${i}`, i % 2 ? "n" : "t", `Column ${i}`)),
  col("godown", "t", "Godown"),
  col("flags", "f", "Flags"),
];

const total = (fit: ReturnType<typeof fitColumns>) => fit.shown.reduce((n, c) => n + fit.widths[c.k], 0);

test("what is drawn always fits the width, to the pixel", () => {
  for (const avail of [600, 800, 1014, 1280, 1700]) {
    for (const check of [false, true]) {
      const fit = fitColumns({ cols: WIDE, avail, check });
      assert.equal(total(fit) + (check ? CHECK_COL : 0), avail, `avail ${avail}`);
      assert.equal(fit.shown.length + fit.folded.length, WIDE.length, "every column is either drawn or folded");
    }
  }
});

test("the name, the status and the flags are kept however many columns fold", () => {
  const fit = fitColumns({ cols: WIDE, avail: 1014 });
  const keys = fit.shown.map((c) => c.k);
  for (const k of ["follow", "party", "flags"]) assert.ok(keys.includes(k), k);
  assert.deepEqual(essentialKeys(WIDE), ["follow", "party", "flags"]);
  /* Drawn in the server's order, not in priority order. */
  assert.deepEqual(keys, WIDE.filter((c) => keys.includes(c.k)).map((c) => c.k));
});

test("the automatic set is a prefix of the server's order, plus the essentials", () => {
  const fit = fitColumns({ cols: WIDE, avail: 1014 });
  const rest = fit.shown.map((c) => c.k).filter((k) => !essentialKeys(WIDE).includes(k));
  const order = WIDE.map((c) => c.k).filter((k) => !essentialKeys(WIDE).includes(k));
  assert.deepEqual(rest, order.slice(0, rest.length));
});

test("a list that fits draws everything and shares the spare width to text", () => {
  const cols = [col("a", "b", "Item"), col("b", "n", "Qty"), col("c", "d", "Date")];
  const fit = fitColumns({ cols, avail: 1000 });
  assert.equal(fit.folded.length, 0);
  assert.equal(fit.widths.b, minWidth(cols[1]));
  assert.equal(fit.widths.c, minWidth(cols[2]));
  assert.equal(fit.widths.a, 1000 - minWidth(cols[1]) - minWidth(cols[2]));
});

test("a person's pick is honoured as far as the width allows, and the rest is counted", () => {
  const chosen = WIDE.map((c) => c.k);
  const fit = fitColumns({ cols: WIDE, avail: 1014, chosen });
  assert.ok(fit.dropped > 0);
  assert.equal(fit.shown.length + fit.dropped, chosen.length);
  const few = fitColumns({ cols: WIDE, avail: 1014, chosen: ["x3", "godown"] });
  assert.deepEqual(few.shown.map((c) => c.k), ["x3", "godown"], "an unpicked essential is not forced back in");
  assert.equal(few.dropped, 0);
});

test("a long heading word widens its column rather than overflowing it", () => {
  assert.ok(minWidth(col("v", "n", "Verification")) > minWidth(col("q", "n", "Qty")));
});

test("the first column is drawn even when nothing fits", () => {
  const fit = fitColumns({ cols: WIDE, avail: 50 });
  assert.equal(fit.shown.length, 1);
});
