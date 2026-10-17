import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { REQUEST_STATUSES, isHeldByRequest, isOpen } from "@/lib/website-cms/review-status";
import { LockedFields } from "./cms-ui/locked-fields";

/* ---------------------------------------------------------------------------
 * An item held by a review request is READ-ONLY in the editor — not merely
 * un-saveable.
 *
 * A disabled Save button lets somebody type for ten minutes into a box the
 * server was always going to refuse, and lose it. So the fields themselves are
 * turned off. This pins three things: which items count as held (one rule, shared
 * by both editors and the lists), that the wrapper really is a disabled
 * `<fieldset>` — the one element that turns off every input, text box, selector
 * and button inside it, including the ones a component draws later — and that
 * both editors put their fields inside it.
 * ------------------------------------------------------------------------- */

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** What a component function returns, without a renderer: the element it asked for. */
const element = (locked: boolean) => LockedFields({ locked, children: React.createElement("input", { name: "name" }) }) as React.ReactElement<{
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
  "data-locked"?: string;
}>;

describe("which items are held", () => {
  it("only an item in an OPEN request is held — submitted or approved, and nothing else", () => {
    for (const status of REQUEST_STATUSES) {
      assert.equal(isHeldByRequest({ status }), isOpen(status), status);
    }
    assert.equal(isHeldByRequest({ status: "submitted" }), true);
    assert.equal(isHeldByRequest({ status: "approved" }), true);
    for (const status of ["rejected", "revoked", "expired", "stale", "published", "withdrawn"] as const) {
      assert.equal(isHeldByRequest({ status }), false, `${status} frees the item for editing`);
    }
  });

  it("an item with no request at all is not held", () => {
    assert.equal(isHeldByRequest(undefined), false);
    assert.equal(isHeldByRequest(null), false);
  });
});

describe("the read-only wrapper", () => {
  it("is a disabled fieldset while locked, so every control inside it is off", () => {
    const el = element(true);
    assert.equal(el.type, "fieldset");
    assert.equal(el.props.disabled, true);
    assert.equal(el.props["data-locked"], "true");
    assert.match(el.props.className ?? "", /opacity-70/, "dimmed, to read — not hidden");
  });

  it("is an ordinary, enabled fieldset when nothing holds the item", () => {
    const el = element(false);
    assert.equal(el.type, "fieldset");
    assert.equal(el.props.disabled, false);
    assert.equal(el.props["data-locked"], undefined);
    assert.doesNotMatch(el.props.className ?? "", /opacity/);
  });

  it("keeps what it was given, unchanged, inside", () => {
    const child = element(true).props.children as React.ReactElement<{ name: string }>;
    assert.equal(child.type, "input");
    assert.equal(child.props.name, "name");
  });

  it("draws no frame of its own: no border, no padding, no margin", () => {
    assert.match(element(true).props.className ?? "", /\bborder-0\b.*\bp-0\b|\bp-0\b.*\bborder-0\b/);
    assert.match(element(true).props.className ?? "", /\bm-0\b/);
    assert.match(element(true).props.className ?? "", /\bmin-w-0\b/, "a fieldset otherwise refuses to shrink inside a drawer");
  });
});

describe("both editors put their fields inside it", () => {
  for (const [file, what] of [
    ["content-screen.tsx", "the list editor — products, industries, gallery, jobs, testimonials, milestones, SEO"],
    ["doc-editor.tsx", "the document editor — pages, settings, menus"],
  ] as const) {
    it(`${file} (${what})`, () => {
      const src = read("src", "app", "website", "cms-ui", file);
      assert.match(src, /import \{ LockedFields \} from "\.\/locked-fields"/);
      assert.match(src, /<LockedFields locked=\{locked\}>\s*<FieldEditor /, "the field editor is INSIDE the lock");
      assert.match(src, /const locked = isHeldByRequest\(review\)/, "locked comes from the one shared rule");
      assert.doesNotMatch(src, /review\.status === "submitted" \|\| review\.status === "approved"/, "no second, hand-written copy of the rule");
    });
  }

  it("the lock notice stays, and Save is still off — the banner explains what the fields no longer allow", () => {
    for (const file of ["content-screen.tsx", "doc-editor.tsx"]) {
      const src = read("src", "app", "website", "cms-ui", file);
      assert.match(src, /ReviewLockNotice/);
      assert.match(src, /disabled=\{busy !== null \|\| locked/);
    }
  });

  it("the list screen decides 'held' with the same rule, so a menu never offers what the editor then refuses", () => {
    assert.match(read("src", "app", "website", "cms-ui", "content-screen.tsx"), /const held = \(item: ItemView\) => isHeldByRequest\(review\[item\.id\]\)/);
  });
});

describe("reviewers get no publish-on-behalf button", () => {
  // Comments out first: the doc comment above the NEXT component would otherwise be part of this one's slice.
  const src = read("src", "app", "website", "cms-ui", "review-ui.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = (name: string) => src.slice(src.indexOf(`export function ${name}(`)).split(/\nexport function /)[0];

  it("the reviewer's actions are grant, reject and revoke — and nothing that publishes", () => {
    const reviewer = body("ReviewActions");
    assert.doesNotMatch(reviewer, /publishApproved|publishItems|Publish approved changes|Publish now/i);
    assert.match(reviewer, /approveRequestAction/);
    assert.match(reviewer, /rejectRequestAction/);
    assert.match(reviewer, /revokeApprovalAction/);
  });

  it("publishing an approved request is offered to the person who submitted it, and only there", () => {
    assert.match(body("EmployeeActions"), /publishApprovedAction/);
    const uses = [...src.matchAll(/publishApprovedAction\(/g)].length;
    assert.equal(uses, 1, "one call site, in the employee's actions");
  });
});
