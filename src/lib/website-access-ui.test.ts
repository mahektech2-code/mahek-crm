/**
 * What ticking and unticking boxes on the Access screen does to the list that is
 * posted — pure, so no database. The screen and the server must agree about what
 * is held: a box that ticks and then saves as nothing, or a right granted as a
 * side effect of ticking something else, are both permission bugs.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { moduleKeysForApp, toggleModule, withoutOrphanLevels, writeLevelsForApp } from "@/lib/modules";

const DASH = "website.dashboard";
const PUB = "website.publish";
const REV = "website.review";
const tick = (from: string[], ...keys: string[]) => keys.reduce((acc, k) => toggleModule("website", acc, k), from);

describe("ticking one Website box", () => {
  test("Dashboard on its own grants neither Publish nor Review", () => {
    assert.deepEqual(tick([], DASH), [DASH]);
  });

  test("Review ticks the Dashboard it is held beside, and not Publish", () => {
    assert.deepEqual([...tick([], REV)].sort(), [DASH, REV].sort());
  });

  test("Publish ticks the Dashboard it is held beside, and not Review", () => {
    assert.deepEqual([...tick([], PUB)].sort(), [DASH, PUB].sort());
  });

  test("Review and Publish are independent: either can be taken away alone", () => {
    const both = tick([], PUB, REV);
    assert.ok(both.includes(PUB) && both.includes(REV));
    const noReview = toggleModule("website", both, REV);
    assert.ok(noReview.includes(PUB) && !noReview.includes(REV));
    const noPublish = toggleModule("website", both, PUB);
    assert.ok(noPublish.includes(REV) && !noPublish.includes(PUB));
    assert.ok(noPublish.includes(DASH));
  });

  test("unticking the Dashboard takes both rights with it", () => {
    const all = tick([], PUB, REV);
    const out = toggleModule("website", all, DASH);
    assert.ok(!out.includes(DASH) && !out.includes(PUB) && !out.includes(REV));
  });

  test("an ordinary screen is one box and touches nothing else", () => {
    assert.deepEqual(tick([DASH], "website.products"), [DASH, "website.products"]);
    assert.deepEqual(toggleModule("website", [DASH, "website.products"], "website.products"), [DASH]);
  });

  test("ticking every box one by one ends with every module, and the list survives the server's own clean-up", () => {
    const every = moduleKeysForApp("website");
    const built = tick([], ...every);
    assert.deepEqual([...built].sort(), [...every].sort());
    assert.deepEqual([...withoutOrphanLevels(built)].sort(), [...every].sort());
  });

  test("a level whose screen is missing is dropped, exactly as the server drops it", () => {
    assert.deepEqual(withoutOrphanLevels([REV, PUB, "website.products"]), ["website.products"]);
  });
});

describe("a screen with an ordinary write level still grants it", () => {
  test("crm.whatsapp ticks its Write level with it, as it always has", () => {
    const level = writeLevelsForApp("crm").get("crm.whatsapp");
    assert.ok(level, "crm.whatsapp has a write level");
    assert.ok(toggleModule("crm", [], "crm.whatsapp").includes(level!));
  });
});

describe("the screen uses these rules", () => {
  const src = readFileSync(new URL("../app/admin/access-section.tsx", import.meta.url), "utf8");
  test("both kinds of checkbox go through toggleModule, and nothing hand-builds the ticked list", () => {
    assert.equal((src.match(/toggleModule\(app, ticked, m\.key\)/g) ?? []).length, 2);
    assert.doesNotMatch(src, /\[\.\.\.ticked, m\.key, writeOf\.get/);
  });
  test("the posted list is cleaned with the server's own rule", () => {
    assert.match(src, /withoutOrphanLevels\(\[\.\.\.new Set\(\[\.\.\.always, \.\.\.next\]\)\]\)/);
  });
});
