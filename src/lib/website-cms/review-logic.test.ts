import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIND_KEYS } from "./kinds";
import {
  APPROVAL_VALID_DAYS,
  ASSIGNABLE_KINDS,
  OPEN_STATUSES,
  REQUEST_STATUSES,
  RETURNED_STATUSES,
  STATUS_HELP,
  STATUS_LABEL,
  TRANSITIONS,
  anyAssignmentCovers,
  approvalExpiry,
  approvalIsLive,
  assignmentCovers,
  canTransition,
  effectiveStatus,
  hasKindWideAssignment,
  isAssignableKind,
  isOpen,
  isRequestStatus,
  isReturned,
  type AssignmentLike,
  type RequestStatus,
} from "./review-status";
import { actionFor, deepEqual, diffData, hasRealChange, isImageValue, mediaDelta, mediaIdsOf } from "./review-diff";
import { freshness, proposedHash } from "./review-hash";

/* ---------------------------------------------------------------------------
 * The pure half of the website review workflow: statuses and their moves,
 * expiry, what an assignment covers, what changed between two copies, and the
 * fingerprint approval is tied to. No database — `review.test.ts` (the
 * integration suite) proves the same rules against real rows.
 * ------------------------------------------------------------------------- */

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/* ----------------------------------------------------------------- statuses */

describe("request statuses and their moves", () => {
  it("has the eight statuses, and every status has a move table, a label", () => {
    assert.deepEqual([...REQUEST_STATUSES], ["submitted", "approved", "rejected", "revoked", "expired", "stale", "published", "withdrawn"]);
    for (const s of REQUEST_STATUSES) {
      assert.ok(TRANSITIONS[s], `${s} has no entry in TRANSITIONS`);
      assert.ok(STATUS_LABEL[s], `${s} has no label`);
    }
  });

  it("allows exactly the moves the workflow describes", () => {
    const allowed: Record<string, string[]> = {
      submitted: ["approved", "rejected", "withdrawn", "stale"],
      approved: ["published", "revoked", "expired", "stale", "withdrawn"],
    };
    for (const from of REQUEST_STATUSES) {
      for (const to of REQUEST_STATUSES) {
        assert.equal(canTransition(from, to), (allowed[from] ?? []).includes(to), `${from} → ${to}`);
      }
    }
  });

  it("never lets a request move out of a finished state, and never to itself", () => {
    for (const s of REQUEST_STATUSES) {
      assert.equal(canTransition(s, s), false, `${s} → ${s}`);
      if (!isOpen(s)) assert.deepEqual([...TRANSITIONS[s]], [], `${s} is finished`);
    }
  });

  it("a request cannot be published straight from submitted: it has to be approved first", () => {
    assert.equal(canTransition("submitted", "published"), false);
    assert.equal(canTransition("rejected", "approved"), false);
    assert.equal(canTransition("rejected", "published"), false);
    assert.equal(canTransition("revoked", "published"), false);
    assert.equal(canTransition("expired", "published"), false);
    assert.equal(canTransition("stale", "published"), false);
  });

  it("only submitted and approved are open, and every returned status gets an explanation", () => {
    assert.deepEqual([...OPEN_STATUSES], ["submitted", "approved"]);
    for (const s of REQUEST_STATUSES) assert.equal(isOpen(s), s === "submitted" || s === "approved", s);
    assert.deepEqual([...RETURNED_STATUSES].sort(), ["expired", "rejected", "revoked", "stale", "withdrawn"]);
    for (const s of RETURNED_STATUSES) {
      assert.equal(isReturned(s), true);
      assert.ok(STATUS_HELP[s], `${s} says nothing about what to do next`);
    }
    assert.equal(isReturned("published"), false);
    assert.equal(isReturned("submitted"), false);
  });

  it("recognises only real statuses", () => {
    assert.equal(isRequestStatus("approved"), true);
    assert.equal(isRequestStatus("Approved"), false);
    assert.equal(isRequestStatus("pending"), false);
    assert.equal(isRequestStatus(null), false);
  });
});

describe("the migration and the code agree on what is allowed", () => {
  const sql = read("drizzle", "0274_website_review_workflow.sql");
  const listIn = (constraint: string): string[] => {
    const at = sql.indexOf(`"${constraint}"`);
    assert.ok(at >= 0, `no ${constraint} constraint in the migration`);
    const open = sql.indexOf("IN (", at);
    const close = sql.indexOf(")", open);
    return [...sql.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  it("status", () => assert.deepEqual(listIn("website_change_request_status_check").sort(), [...REQUEST_STATUSES].sort()));
  it("assignment kinds are the content kinds plus media", () => {
    assert.deepEqual(listIn("website_assignment_kind_check").sort(), [...ASSIGNABLE_KINDS].sort());
    assert.deepEqual([...ASSIGNABLE_KINDS].sort(), [...KIND_KEYS, "media"].sort());
  });
  it("a change item can be for any content kind, but never media (media has no content row)", () => {
    assert.deepEqual(listIn("website_change_item_kind_check").sort(), [...KIND_KEYS].sort());
  });
  it("an item is an add or an edit, and there is no remove in v1", () => {
    assert.deepEqual(listIn("website_change_item_action_check").sort(), ["add", "edit"]);
  });
  it("the schema file mirrors every one of those lists", () => {
    const schema = read("src", "db", "schema.ts");
    const block = schema.slice(schema.indexOf("export const websiteAssignment"), schema.indexOf("export type WebsiteAssignmentRow"));
    for (const s of REQUEST_STATUSES) assert.ok(block.includes(`'${s}'`), `schema.ts lacks status ${s}`);
    for (const k of ASSIGNABLE_KINDS) assert.ok(block.includes(`'${k}'`), `schema.ts lacks kind ${k}`);
    for (const name of [
      "website_change_request_not_self_reviewed",
      "website_change_request_reject_has_reason",
      "website_change_request_approved_has_expiry",
      "website_change_request_published_has_stamp",
      "website_change_item_open_key",
      "website_change_item_add_has_no_base",
      "website_assignment_active_key",
      "website_review_setting_single_row",
    ]) {
      assert.ok(block.includes(`"${name}"`), `schema.ts lacks ${name}`);
      assert.ok(sql.includes(`"${name}"`), `the migration lacks ${name}`);
    }
  });
  it("enforces the rules that must hold whatever code writes the row", () => {
    assert.match(sql, /"reviewer_id" IS NULL OR "reviewer_id" <> "submitter_id"/, "nobody reviews their own submission");
    assert.match(sql, /length\(btrim\(coalesce\("reject_reason", ''\)\)\) > 0/, "a rejection carries a reason");
    assert.match(sql, /"open_content_id"\) WHERE "open_content_id" IS NOT NULL/, "one open request per item");
  });
  it("is additive: no drops, no alters, and no grant of the review module to anybody", () => {
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(code, /\bDROP\b/i);
    assert.doesNotMatch(code, /\bALTER\s+TABLE\b/i);
    assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i); // `ON DELETE CASCADE` on a foreign key is not a delete of rows
    assert.doesNotMatch(code, /\bUPDATE\b/i);
    assert.doesNotMatch(code, /app_module_access/i);
    assert.doesNotMatch(code, /website\.review/);
  });
  it("is in journal order, newer than every migration before it", () => {
    /* Every EARLIER entry, not every other: a migration added after this one
       is newer by design, and must not fail this test. */
    const journal = JSON.parse(read("drizzle", "meta", "_journal.json")) as { entries: { idx: number; when: number; tag: string }[] };
    const at = journal.entries.findIndex((e) => e.tag === "0274_website_review_workflow");
    assert.ok(at >= 0, "no journal entry");
    const mine = journal.entries[at];
    for (const e of journal.entries.slice(0, at)) {
      assert.ok(mine.when > e.when, `${e.tag} has a later or equal 'when' — drizzle would skip this migration`);
    }
    assert.equal(mine.idx, at);
  });
});

/* ------------------------------------------------------------------- expiry */

describe("approval expiry", () => {
  const approvedAt = new Date("2026-10-01T10:00:00.000Z");

  it("lasts seven days", () => {
    assert.equal(APPROVAL_VALID_DAYS, 7);
    assert.equal(approvalExpiry(approvedAt).toISOString(), "2026-10-08T10:00:00.000Z");
  });

  it("is usable up to the instant before expiry and not at it", () => {
    const expires = approvalExpiry(approvedAt);
    const r = { status: "approved" as RequestStatus, approvalExpiresAt: expires };
    assert.equal(approvalIsLive(r, new Date(expires.getTime() - 1)), true);
    assert.equal(approvalIsLive(r, expires), false);
    assert.equal(approvalIsLive(r, new Date(expires.getTime() + 1)), false);
  });

  it("only an approved request has a live approval", () => {
    const expires = approvalExpiry(approvedAt);
    for (const s of REQUEST_STATUSES) {
      if (s === "approved") continue;
      assert.equal(approvalIsLive({ status: s, approvalExpiresAt: expires }, approvedAt), false, s);
    }
    assert.equal(approvalIsLive({ status: "approved", approvalExpiresAt: null }, approvedAt), false);
  });

  it("shows a lapsed approval as expired before any job has moved it", () => {
    const expires = approvalExpiry(approvedAt);
    const after = new Date(expires.getTime() + 1000);
    assert.equal(effectiveStatus({ status: "approved", approvalExpiresAt: expires }, after), "expired");
    assert.equal(effectiveStatus({ status: "approved", approvalExpiresAt: expires }, approvedAt), "approved");
    assert.equal(effectiveStatus({ status: "rejected", approvalExpiresAt: null }, after), "rejected");
    assert.equal(effectiveStatus({ status: "submitted", approvalExpiresAt: null }, after), "submitted");
  });
});

/* -------------------------------------------------------------- assignments */

describe("what an assignment covers", () => {
  const live = (kind: string, contentId: string | null): AssignmentLike => ({ kind, contentId, revokedAt: null });
  const revoked = (kind: string, contentId: string | null): AssignmentLike => ({ kind, contentId, revokedAt: new Date() });

  it("a per-item assignment covers that item and nothing else", () => {
    const a = live("page", "wc_about");
    assert.equal(assignmentCovers(a, { kind: "page", contentId: "wc_about" }), true);
    assert.equal(assignmentCovers(a, { kind: "page", contentId: "wc_contact" }), false);
  });

  it("a kind-wide assignment covers every item of the kind and no other kind", () => {
    const a = live("product", null);
    assert.equal(assignmentCovers(a, { kind: "product", contentId: "wc_1" }), true);
    assert.equal(assignmentCovers(a, { kind: "product", contentId: "wc_2" }), true);
    assert.equal(assignmentCovers(a, { kind: "industry", contentId: "wc_1" }), false);
    assert.equal(assignmentCovers(a, { kind: "media", contentId: null }), false);
  });

  it("only a kind-wide assignment covers an item that does not exist yet", () => {
    assert.equal(assignmentCovers(live("product", null), { kind: "product", contentId: null }), true);
    assert.equal(assignmentCovers(live("product", "wc_1"), { kind: "product", contentId: null }), false);
  });

  it("a revoked assignment covers nothing", () => {
    assert.equal(assignmentCovers(revoked("product", null), { kind: "product", contentId: "wc_1" }), false);
    assert.equal(anyAssignmentCovers([revoked("product", null)], { kind: "product", contentId: "wc_1" }), false);
    assert.equal(hasKindWideAssignment([revoked("product", null)], "product"), false);
  });

  it("media is assigned by kind only", () => {
    assert.equal(assignmentCovers(live("media", null), { kind: "media", contentId: null }), true);
    assert.equal(isAssignableKind("media"), true);
    assert.equal(hasKindWideAssignment([live("media", null)], "media"), true);
  });

  it("one covering assignment among several is enough", () => {
    const set = [live("page", "wc_a"), live("seo", null), live("product", "wc_p")];
    assert.equal(anyAssignmentCovers(set, { kind: "seo", contentId: "wc_any" }), true);
    assert.equal(anyAssignmentCovers(set, { kind: "page", contentId: "wc_a" }), true);
    assert.equal(anyAssignmentCovers(set, { kind: "page", contentId: "wc_b" }), false);
    assert.equal(anyAssignmentCovers([], { kind: "page", contentId: "wc_a" }), false);
  });

  it("kind-wide means kind-wide for reordering and creating too", () => {
    assert.equal(hasKindWideAssignment([live("product", "wc_1")], "product"), false);
    assert.equal(hasKindWideAssignment([live("product", null)], "product"), true);
    assert.equal(hasKindWideAssignment([live("product", null)], "industry"), false);
  });

  it("knows what can be assigned", () => {
    for (const k of KIND_KEYS) assert.equal(isAssignableKind(k), true, k);
    assert.equal(isAssignableKind("media"), true);
    assert.equal(isAssignableKind("blog"), false);
    assert.equal(isAssignableKind(undefined), false);
  });
});

/* --------------------------------------------------------------------- diff */

describe("the field-by-field diff", () => {
  it("is empty for identical content, whatever order the keys came back in", () => {
    assert.deepEqual(diffData({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), []);
  });

  it("reports an edited text field", () => {
    assert.deepEqual(diffData({ name: "Old" }, { name: "New" }), [{ path: "name", change: "edited", before: "Old", after: "New" }]);
  });

  it("a cleared field is an EDIT that shows, not a skipped empty", () => {
    assert.deepEqual(diffData({ tag: "Fast drying" }, { tag: "" }), [{ path: "tag", change: "edited", before: "Fast drying", after: "" }]);
    assert.deepEqual(diffData({ note: "x" }, { note: null }), [{ path: "note", change: "edited", before: "x", after: null }]);
  });

  it("a field that vanished from the data is a removal, and a new one an addition", () => {
    assert.deepEqual(diffData({ a: 1, b: 2 }, { a: 1 }), [{ path: "b", change: "removed", before: 2, after: undefined }]);
    assert.deepEqual(diffData({ a: 1 }, { a: 1, b: 2 }), [{ path: "b", change: "added", before: undefined, after: 2 }]);
  });

  it("a replaced image is an edit at its field", () => {
    const d = diffData({ image: "/cms-media/wm_old00000001/a.webp" }, { image: "/cms-media/wm_new00000002/b.webp" });
    assert.equal(d.length, 1);
    assert.equal(d[0].path, "image");
    assert.equal(d[0].change, "edited");
    assert.equal(isImageValue(d[0].before), true);
    assert.equal(isImageValue(d[0].after), true);
  });

  it("walks nested objects with dotted paths", () => {
    assert.deepEqual(diffData({ specs: { Appearance: "Clear", Odour: "Mild" } }, { specs: { Appearance: "Hazy", Odour: "Mild" } }), [
      { path: "specs.Appearance", change: "edited", before: "Clear", after: "Hazy" },
    ]);
  });

  it("walks lists by position", () => {
    assert.deepEqual(diffData({ benefits: ["Fast", "Cheap"] }, { benefits: ["Fast", "Cheaper"] }), [
      { path: "benefits[1]", change: "edited", before: "Cheap", after: "Cheaper" },
    ]);
    assert.deepEqual(diffData({ benefits: ["Fast"] }, { benefits: ["Fast", "Clear"] }), [
      { path: "benefits[1]", change: "added", before: undefined, after: "Clear" },
    ]);
    assert.deepEqual(diffData({ benefits: ["Fast", "Clear"] }, { benefits: ["Fast"] }), [
      { path: "benefits[1]", change: "removed", before: "Clear", after: undefined },
    ]);
  });

  it("does not call a reorder 'nothing happened'", () => {
    assert.equal(diffData({ benefits: ["A", "B"] }, { benefits: ["B", "A"] }).length, 2);
  });

  it("emptying a list is visible", () => {
    const d = diffData({ benefits: ["A", "B"] }, { benefits: [] });
    assert.deepEqual(d.map((c) => [c.path, c.change]), [["benefits[0]", "removed"], ["benefits[1]", "removed"]]);
  });

  it("something that was not live reports every field as added", () => {
    const d = diffData(null, { name: "New", specs: { Appearance: "Clear" }, benefits: ["Fast"] });
    assert.deepEqual(d.map((c) => [c.path, c.change]), [["benefits[0]", "added"], ["name", "added"], ["specs.Appearance", "added"]]);
    assert.deepEqual(diffData(undefined, { a: 1 }).map((c) => c.change), ["added"]);
  });

  it("a nested object appearing or disappearing is reported field by field", () => {
    assert.deepEqual(diffData({ a: 1 }, { a: 1, social: { x: "u", y: "v" } }).map((c) => [c.path, c.change]), [["social.x", "added"], ["social.y", "added"]]);
    assert.deepEqual(diffData({ social: { x: "u" } }, {}).map((c) => [c.path, c.change]), [["social.x", "removed"]]);
  });

  it("an empty container appearing or vanishing is still one visible change", () => {
    assert.deepEqual(diffData({}, { tags: [] }).map((c) => [c.path, c.change]), [["tags", "added"]]);
    assert.deepEqual(diffData({ tags: [] }, {}).map((c) => [c.path, c.change]), [["tags", "removed"]]);
  });

  it("a value changing type is one edit, not a pile of fragments", () => {
    assert.deepEqual(diffData({ v: "text" }, { v: ["a", "b"] }).map((c) => [c.path, c.change]), [["v", "edited"]]);
    assert.deepEqual(diffData({ v: { a: 1 } }, { v: 5 }).map((c) => [c.path, c.change]), [["v", "edited"]]);
  });

  it("does not mutate what it is given", () => {
    const before = { a: { b: [1, 2] } };
    const after = { a: { b: [1, 3] } };
    const copy = JSON.stringify([before, after]);
    diffData(before, after);
    assert.equal(JSON.stringify([before, after]), copy);
  });
});

describe("what counts as a real change, and what kind of submission it is", () => {
  it("something not live is always a change, and is an add", () => {
    assert.equal(hasRealChange(null, { name: "x" }), true);
    assert.equal(actionFor(null), "add");
    assert.equal(actionFor(undefined), "add");
  });
  it("a live item is a change only if it differs, and is an edit", () => {
    assert.equal(hasRealChange({ name: "x" }, { name: "x" }), false);
    assert.equal(hasRealChange({ name: "x" }, { name: "y" }), true);
    assert.equal(hasRealChange({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
    assert.equal(actionFor({ name: "x" }), "edit");
  });
  it("clearing a field is a real change", () => {
    assert.equal(hasRealChange({ tag: "x" }, { tag: "" }), true);
  });
  it("deepEqual tells arrays by order and objects by content", () => {
    assert.equal(deepEqual([1, 2], [2, 1]), false);
    assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false);
    assert.equal(deepEqual(null, undefined), false);
  });
});

/* ------------------------------------------------------------------- images */

describe("the images a change moves", () => {
  const A = "/cms-media/wm_aaaaaaaaaaaa/a.webp";
  const B = "/cms-media/wm_bbbbbbbbbbbb/b.webp";
  const C = "/cms-media/wm_cccccccccccc/c.webp";

  it("finds the uploaded files a piece of content points at", () => {
    assert.deepEqual(mediaIdsOf({ image: A, gallery: [B, "/images/ships-with-site.webp"] }), ["wm_aaaaaaaaaaaa", "wm_bbbbbbbbbbbb"]);
    assert.deepEqual(mediaIdsOf(null), []);
    assert.deepEqual(mediaIdsOf({ name: "no images" }), []);
  });

  it("names the old and the new file when one is replaced", () => {
    const d = mediaDelta(mediaIdsOf({ image: A }), mediaIdsOf({ image: B }));
    assert.deepEqual(d, { added: ["wm_bbbbbbbbbbbb"], removed: ["wm_aaaaaaaaaaaa"], kept: [] });
  });

  it("separates what was kept from what changed", () => {
    const d = mediaDelta(mediaIdsOf({ images: [A, B] }), mediaIdsOf({ images: [B, C] }));
    assert.deepEqual(d, { added: ["wm_cccccccccccc"], removed: ["wm_aaaaaaaaaaaa"], kept: ["wm_bbbbbbbbbbbb"] });
  });

  it("an item that was not live has no 'before' images", () => {
    const d = mediaDelta(mediaIdsOf(null), mediaIdsOf({ image: A }));
    assert.deepEqual(d, { added: ["wm_aaaaaaaaaaaa"], removed: [], kept: [] });
  });

  it("draws an image value as a picture, and an ordinary string as text", () => {
    assert.equal(isImageValue(A), true);
    assert.equal(isImageValue("/images/test-thinner.webp"), true);
    assert.equal(isImageValue("Fast drying thinner"), false);
    assert.equal(isImageValue(42), false);
  });
});

/* -------------------------------------------------------------------- hash */

describe("the fingerprint approval is tied to", () => {
  it("is 64 hex characters, and the same for the same content in any key order", () => {
    const h = proposedHash({ a: 1, b: { c: [1, 2], d: "x" } });
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(proposedHash({ b: { d: "x", c: [1, 2] }, a: 1 }), h);
  });

  it("changes when any value changes — including clearing a field", () => {
    const base = proposedHash({ tag: "Fast", n: 1 });
    assert.notEqual(proposedHash({ tag: "Fast", n: 2 }), base);
    assert.notEqual(proposedHash({ tag: "", n: 1 }), base);
    assert.notEqual(proposedHash({ n: 1 }), base);
  });

  it("depends on list order", () => {
    assert.notEqual(proposedHash({ l: ["a", "b"] }), proposedHash({ l: ["b", "a"] }));
  });

  it("tells fresh content from moved content", () => {
    const data = { name: "Thinner", benefits: ["Fast"] };
    const frozen = { submittedVersion: 4, proposedHash: proposedHash(data) };
    assert.equal(freshness(frozen, { version: 4, data: { benefits: ["Fast"], name: "Thinner" } }), "fresh");
    assert.equal(freshness(frozen, { version: 5, data: { ...data, name: "Thinner 2" } }), "version_moved");
    assert.equal(freshness(frozen, { version: 5, data }), "version_moved", "a re-save of the same text is still a new version");
    assert.equal(freshness(frozen, { version: 4, data: { ...data, name: "Sneaky" } }), "content_changed");
  });
});

/* -------------------------------------------------------------------- scope */

import { MODULE_SLUGS } from "./kinds";
import { SLUG_KIND, filterToScope, makeScope, slugVisible } from "./review-scope";
import { QUEUE_TABS, STATUS_TONE, isQueueTab, tabOf } from "./review-status";

describe("what a person is shown (the scope)", () => {
  const live = (kind: string, contentId: string | null): AssignmentLike => ({ kind, contentId, revokedAt: null });
  const rows = [
    { id: "p1", kind: "product" },
    { id: "p2", kind: "product" },
    { id: "i1", kind: "industry" },
    { id: "g1", kind: "gallery" },
  ];

  it("shows everything when assignments are not enforced — whoever the person is", () => {
    const scope = makeScope({ enforced: false, direct: false, assignments: [] });
    assert.equal(scope.everything, true);
    assert.deepEqual(filterToScope(scope, rows), rows);
    assert.equal(scope.hasKind("media"), true);
    assert.equal(scope.kindWide("product"), true);
  });

  it("shows everything to a holder of Publish or Review even when assignments are enforced", () => {
    const scope = makeScope({ enforced: true, direct: true, assignments: [] });
    assert.deepEqual(filterToScope(scope, rows), rows);
  });

  it("shows an enforced editor with nothing assigned nothing at all", () => {
    const scope = makeScope({ enforced: true, direct: false, assignments: [] });
    assert.equal(scope.everything, false);
    assert.deepEqual(filterToScope(scope, rows), []);
    for (const k of [...KIND_KEYS, "media" as const]) {
      assert.equal(scope.hasKind(k), false, k);
      assert.equal(scope.kindWide(k), false, k);
    }
  });

  it("shows an enforced editor exactly their own items", () => {
    const scope = makeScope({ enforced: true, direct: false, assignments: [live("product", "p2"), live("gallery", null)] });
    assert.deepEqual(filterToScope(scope, rows).map((r) => r.id), ["p2", "g1"]);
    assert.equal(scope.covers("product", "p1"), false);
    assert.equal(scope.covers("product", "p2"), true);
  });

  it("a kind-wide assignment shows the kind and lets them add and reorder; a per-item one does not", () => {
    const scope = makeScope({ enforced: true, direct: false, assignments: [live("product", "p1"), live("industry", null)] });
    assert.equal(scope.hasKind("product"), true);
    assert.equal(scope.kindWide("product"), false, "one product is not the whole list");
    assert.equal(scope.kindWide("industry"), true);
    assert.equal(scope.hasKind("gallery"), false);
  });

  it("a revoked assignment shows nothing", () => {
    const scope = makeScope({ enforced: true, direct: false, assignments: [{ kind: "product", contentId: null, revokedAt: new Date() }] });
    assert.deepEqual(filterToScope(scope, rows), []);
    assert.equal(scope.hasKind("product"), false);
  });

  it("an item the scope covers is covered for its own kind only: the same id under another kind is not", () => {
    const scope = makeScope({ enforced: true, direct: false, assignments: [live("product", "x1")] });
    assert.equal(scope.covers("product", "x1"), true);
    assert.equal(scope.covers("industry", "x1"), false);
  });

  it("every Website module slug maps to the kind that owns it, and media to media", () => {
    for (const slug of MODULE_SLUGS) assert.ok(SLUG_KIND[slug], `${slug} has no kind`);
    assert.equal(SLUG_KIND.media, "media");
    assert.equal(SLUG_KIND.products, "product");
    assert.equal(SLUG_KIND.careers, "job");
    assert.equal(SLUG_KIND.pages, "page");
  });

  it("an enforced editor sees a module only if assigned something in it; the dashboard is always theirs", () => {
    const scope = makeScope({ enforced: true, direct: false, assignments: [live("product", "p1"), live("media", null)] });
    assert.equal(slugVisible(scope, "products"), true);
    assert.equal(slugVisible(scope, "media"), true);
    assert.equal(slugVisible(scope, "industries"), false);
    assert.equal(slugVisible(scope, "settings"), false);
    assert.equal(slugVisible(scope, "dashboard"), true);
  });
});

describe("the review queue's tabs", () => {
  it("partition the statuses: every status is on exactly one tab", () => {
    for (const s of REQUEST_STATUSES) {
      const tabs = QUEUE_TABS.filter((t) => (t.statuses as readonly string[]).includes(s));
      assert.equal(tabs.length, 1, `${s} is on ${tabs.length} tabs`);
      assert.equal(tabOf(s), tabs[0].key);
    }
  });
  it("has the five tabs a reviewer asks for", () => {
    assert.deepEqual(QUEUE_TABS.map((t) => t.key), ["pending", "approved", "published", "rejected", "closed"]);
    assert.equal(isQueueTab("pending"), true);
    assert.equal(isQueueTab("everything"), false);
    assert.equal(isQueueTab(undefined), false);
  });
  it("every status has a tone to draw its badge in", () => {
    for (const s of REQUEST_STATUSES) assert.ok(STATUS_TONE[s], s);
  });
});
