/**
 * WHAT THE ACCESS DIALOG SAYS A LEVEL CARRIES.
 *
 * The lines under each level picker are read off the capability matrix, so
 * these tests pin the reading rather than the matrix: that every capability
 * has words, that the words that separate a manager from an associate are the
 * ones shown, and that nothing promises a power the matrix does not grant.
 *
 * Pure, so nothing here needs a database.
 */
import { getModule } from "./modules";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES } from "./capability-matrix";
import { APP_IDS } from "./apps";
import { BOOK_LINE, CAPABILITY_LABELS, levelCarries } from "./capability-labels";

describe("capability labels", () => {
  test("every capability has a label, and no two share one", () => {
    const labels = CAPABILITIES.map((c) => CAPABILITY_LABELS[c]);
    for (const [i, label] of labels.entries()) {
      assert.ok(label && label.trim().length > 0, `${CAPABILITIES[i]} has no words`);
    }
    assert.equal(new Set(labels).size, labels.length, "two capabilities read the same on the screen");
  });

  test("no label leaks the dotted key it stands for", () => {
    for (const c of CAPABILITIES) assert.ok(!CAPABILITY_LABELS[c].includes("."), c);
  });
});

const PIPELINE = getModule("sales.lead-pipeline")!.label;

describe("levelCarries", () => {
  test("is never empty, for any app at any level", () => {
    for (const app of APP_IDS) {
      for (const level of ["associate", "manager", "admin"] as const) {
        assert.ok(levelCarries(app, level).length > 0, `${app} ${level} says nothing`);
      }
    }
  });

  test("a CRM associate works the book, as one line, and decides nothing", () => {
    const lines = levelCarries("crm", "associate");
    assert.equal(lines[0], BOOK_LINE);
    assert.ok(!lines.includes(CAPABILITY_LABELS["customer.deactivate"]));
    assert.ok(!lines.includes(CAPABILITY_LABELS["call.log"]), "the book's basics are folded into one line");
  });

  test("a CRM manager carries the management line items and still never approves an order", () => {
    const lines = levelCarries("crm", "manager");
    assert.ok(lines.includes(CAPABILITY_LABELS["customer.deactivate"]));
    assert.ok(lines.includes(CAPABILITY_LABELS["team.report"]));
    assert.ok(!lines.includes(CAPABILITY_LABELS["order.approve"]));
  });

  test("the Accounts manager approves orders and the Accounts associate does not", () => {
    assert.ok(levelCarries("accounts", "manager").includes(CAPABILITY_LABELS["order.approve"]));
    assert.ok(!levelCarries("accounts", "associate").includes(CAPABILITY_LABELS["order.approve"]));
  });

  test("admin of an app is that app's manager plus what it hands out, never the platform", () => {
    const admin = levelCarries("crm", "admin");
    for (const line of levelCarries("crm", "manager")) assert.ok(admin.includes(line), line);
    assert.ok(!admin.includes(CAPABILITY_LABELS["access.manage"]));
    assert.ok(admin.some((l) => l.startsWith("Also opens")), "the offByDefault screens are named");
    /* The Sales Dashboard's pipeline is explicit-only: no admin bypass reaches it. */
    const salesAdmin = levelCarries("sales", "admin");
    assert.ok(!salesAdmin.some((l) => l.includes(PIPELINE)), "an explicitOnly seat is never promised");
  });

  test("admin on the Admin Console is the platform administrator", () => {
    const lines = levelCarries("admin", "admin");
    assert.match(lines[0], /platform administrator/);
    assert.ok(lines.includes(CAPABILITY_LABELS["access.manage"]));
  });

  test("HRMS and the ERP point at their powers", () => {
    assert.match(levelCarries("hrms", "associate")[0], /powers ticked below/);
    assert.match(levelCarries("erp", "manager")[0], /powers ticked below/);
    assert.match(levelCarries("hrms", "admin")[0], /Every HRMS power/);
    assert.match(levelCarries("erp", "admin")[0], /Every ERP power/);
  });

  test("an app with no capabilities says it opens screens and nothing more", () => {
    assert.match(levelCarries("enquiries", "manager")[0], /screens ticked below/);
    assert.match(levelCarries("reports", "associate")[0], /screens ticked below/);
    assert.ok(levelCarries("reports", "manager").includes(CAPABILITY_LABELS["team.report"]));
  });

  test("recording a payment, which everybody holds, is said about nobody", () => {
    for (const app of APP_IDS) {
      for (const level of ["associate", "manager"] as const) {
        assert.ok(!levelCarries(app, level).includes(CAPABILITY_LABELS["payment.record"]), `${app} ${level}`);
      }
    }
  });
});
