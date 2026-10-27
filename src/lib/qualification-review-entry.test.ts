import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/* ---------------------------------------------------------------------------
 * THE MANAGER CAN FIND THE QUALIFICATION REVIEW.
 *
 * It shipped reachable from one place — a link card on the Qualify page — so a
 * Sales Manager on the Verification call, on the lead record, or in their own
 * workspace never saw it. These pin every way in, as text, because a link that
 * goes missing fails silently: nothing breaks, the manager just cannot find the
 * screen.
 * ------------------------------------------------------------------------- */

const read = (p: string) => readFileSync(p, "utf8");

describe("the Verification call", () => {
  const form = read("src/components/leads/verification-form.tsx");
  test("offers a link to every answer on the lead, in a new tab so the call is not lost", () => {
    assert.match(form, /reviewHref\?: string/);
    assert.match(form, /href=\{reviewHref\}\s+target="_blank"/);
    assert.match(form, /Open every Suspect, Prospect and Qualification answer/);
  });
  test("both places that draw it pass the link", () => {
    assert.match(read("src/components/leads/record/lead-record-screen.tsx"), /reviewHref=\{`\$\{base\}\/review`\}/);
    assert.match(
      read("src/components/leads/qualify/verification/verification-queue-screen.tsx"),
      /reviewHref=\{leadHref\(workspace, `leads\/\$\{calling\.customerId\}\/review`\)\}/,
    );
  });
});

describe("the lead record", () => {
  const record = read("src/components/leads/record/lead-record-screen.tsx");
  test("links to the review from the Qualification panel and the Verification panel", () => {
    assert.ok((record.match(/href=\{`\$\{base\}\/review`\}/g) ?? []).length >= 2, "two links on the record");
    assert.match(record, /Open the review/);
    assert.match(record, /See all answers/);
  });
});

describe("the Sales Manager's own workspace", () => {
  test("has its own review route, inside the tree its module guard covers", () => {
    const page = "src/app/crm/leads/sales-manager/[id]/review/page.tsx";
    assert.ok(existsSync(page), "the route exists");
    assert.match(read("src/app/crm/leads/sales-manager/layout.tsx"), /requireModule\(user\.id, "crm\.sales-manager"\)/);
    assert.match(read(page), /closeBase="\/crm\/leads\/sales-manager"/);
  });
  test("their record links to it", () => {
    assert.match(
      read("src/components/sales-lead-pipeline/desk/record-screen.tsx"),
      /href=\{`\$\{links\.base\}\/\$\{lead\.id\}\/review`\}/,
    );
  });
  test("Close goes back into THEIR workspace, not into a page their module may not open", () => {
    assert.match(read("src/components/leads/pages/leads-record-review.tsx"), /closeHref=\{closeBase \? `\$\{closeBase\}\/\$\{model\.customerId\}` : undefined\}/);
    const screen = read("src/components/leads/review/qualification-review-screen.tsx");
    assert.match(screen, /const closeTo = closeHref \?\? leadHref/);
    assert.ok((screen.match(/href=\{closeTo\}/g) ?? []).length === 2, "both Close controls use it");
  });
});

describe("the CRM's own routes are unchanged", () => {
  test("the review is still reachable from the Qualify page and the CRM and Sales workspaces", () => {
    assert.ok(existsSync("src/app/crm/leads/[id]/review/page.tsx"));
    assert.ok(existsSync("src/app/sales/leads/[id]/review/page.tsx"));
    assert.match(read("src/components/leads/pages/leads-record-qualify.tsx"), /<ReviewEntry/);
  });
});
