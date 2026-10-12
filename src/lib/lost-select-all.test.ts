import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ---------------------------------------------------------------------------
 * LEAD MANAGEMENT -> LOST: SELECT ALL, AND REVERSING MANY AT ONCE.
 *
 * The screen is a client component, so what is pinned here is the shape that
 * matters and cannot be seen at runtime from a test: that the bulk act is the
 * existing single reopen run once per lead (no second path to "reopen"), and
 * that a lead the desk may not reverse is never offered a box.
 * ------------------------------------------------------------------------- */

const screen = readFileSync("src/components/leads/lost/lost-leads-screen.tsx", "utf8");
const dialog = readFileSync("src/components/leads/lost/reopen-lost-dialog.tsx", "utf8");

describe("Lost list: select all", () => {
  test("a header box selects every lead on the page, with a mixed state", () => {
    assert.match(screen, /aria-label="Select every lead on this page"/);
    assert.match(screen, /indeterminate = someOnPage/);
  });

  test("each row has its own box, labelled with the lead", () => {
    assert.match(screen, /aria-label=\{`Select \$\{l\.name\}`\}/);
  });

  test("boxes exist only for somebody who may reverse, and only on leads the seat may reverse", () => {
    assert.match(screen, /\{reopen \? \(\s*<HeadCell width=\{44\}>/);
    assert.match(screen, /reopen\?\.seat === "calling_desk" && l\.lostReason === VERIFICATION_FAILED_CODE/);
  });

  test("a selection bar shows the count, a Reverse button and Clear selection", () => {
    assert.match(screen, /selected<\/span>/);
    assert.match(screen, /Clear selection/);
    assert.match(screen, /<BulkReopenDialog/);
  });
});

describe("Lost list: reversing several is the single reopen, repeated", () => {
  const bulk = dialog.slice(dialog.indexOf("export function BulkReopenDialog"));

  test("it calls the same two actions the single dialog calls, once per lead", () => {
    assert.match(bulk, /for \(const lead of leads\)/);
    assert.match(bulk, /reopenSalesManagerLead\(input\)/);
    assert.match(bulk, /reopenDeskLead\(input\)/);
  });

  test("it writes nothing of its own: no direct database or second action", () => {
    assert.doesNotMatch(bulk, /from "@\/db/);
    assert.doesNotMatch(bulk, /fetch\(/);
  });

  test("a refused lead is named with the server's own sentence", () => {
    assert.match(bulk, /refused\.push\(\{ id: lead\.id, name: lead\.name, why: result\.error \}\)/);
  });

  test("a reason is required, and Other demands a note", () => {
    assert.match(bulk, /disabled=\{busy \|\| !reason \|\| \(needsNote && !note\.trim\(\)\)\}/);
  });
});
