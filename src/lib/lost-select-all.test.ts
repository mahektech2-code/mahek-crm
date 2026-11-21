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

  test("boxes exist only for somebody who may reverse or ask for Dead, and only on leads the seat may act on", () => {
    assert.match(screen, /const canSelect = Boolean\(reopen\) \|\| canMarkDead/);
    assert.match(screen, /\{canSelect \? \(\s*<HeadCell width=\{44\}>/);
    /* Reverse: a lead the desk may not reverse is never offered a box for it. */
    assert.match(screen, /reopen\.seat === "calling_desk" && l\.lostReason === VERIFICATION_FAILED_CODE/);
    /* Dead: a lead already Dead, or with a request waiting, is not offered one either. */
    assert.match(screen, /deadRequestEligibility\(\{ stage: "lost", deadAt: l\.deadAt, pending: l\.deadRequestPending \}\)\.offer/);
  });

  test("a selection bar shows the count, a Reverse button and Clear selection", () => {
    assert.match(screen, /selected<\/span>/);
    assert.match(screen, /Clear selection/);
    assert.match(screen, /<BulkReopenDialog/);
  });

  test("the bar also offers Mark N as Dead, to somebody who may ask for it", () => {
    assert.match(screen, /Mark \{chosenKillable\.length\} as Dead/);
    assert.match(screen, /<BulkMarkDeadDialog/);
  });
});

describe("Lost list: marking several Dead is the single request, repeated", () => {
  const bulkDead = readFileSync("src/components/leads/dead/bulk-mark-dead-dialog.tsx", "utf8");

  test("it sends every selected lead through the one bulk action, and writes nothing of its own", () => {
    assert.match(bulkDead, /requestDeadLeads\(\{/);
    assert.match(bulkDead, /customerIds: leads\.map\(\(l\) => l\.id\)/);
    assert.doesNotMatch(bulkDead, /from "@\/db/);
    assert.doesNotMatch(bulkDead, /fetch\(/);
  });

  test("a lead that was not sent is named with the server's own sentence", () => {
    assert.match(bulkDead, /\{f\.name\}<\/b> — \{f\.why\}/);
  });

  test("a reason is required, and Other demands a note", () => {
    assert.match(bulkDead, /canSend = !result && Boolean\(facts\?\.approverName\) && Boolean\(reason\) && \(!needsNote \|\| Boolean\(note\.trim\(\)\)\)/);
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
