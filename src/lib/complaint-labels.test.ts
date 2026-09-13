import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { COMPLAINT_CATEGORIES } from "./constants";
import {
  COMPLAINT_CATEGORY_LABEL,
  COMPLAINT_PRIORITIES,
  DEFAULT_COMPLAINT_PRIORITY,
  categoryLabel,
  categoryValue,
  isEscalatedPriority,
  priorityLabel,
} from "./complaint-labels";
import { complaintCategoryEnum, severityEnum } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * The two things that can silently go wrong here are a label with nowhere to
 * be stored and a stored value with nothing to be called, and neither shows up
 * at runtime: the first lands the complaint under `other`, the second prints
 * the database's own word at a telecaller. Both are read off the ENUM rather
 * than off a list typed here, so adding a member without a label fails the
 * build instead of a screen — the same shape as `handover.test.ts`.
 * ------------------------------------------------------------------------- */

describe("complaint categories", () => {
  test("every category the app offers maps onto a real enum member", () => {
    const members = new Set<string>(complaintCategoryEnum.enumValues);
    for (const label of COMPLAINT_CATEGORIES) {
      const value = categoryValue(label);
      assert.ok(
        members.has(value),
        `"${label}" maps to "${value}", which the complaint_category enum does not hold`,
      );
    }
  });

  test("no two offered categories collapse onto one value", () => {
    // Ten headings that stored six values would be a picker whose answers
    // cannot be told apart afterwards, which is the whole point of asking.
    const values = COMPLAINT_CATEGORIES.map(categoryValue);
    assert.equal(
      new Set(values).size,
      COMPLAINT_CATEGORIES.length,
      `these collapse: ${values.join(", ")}`,
    );
  });

  test("every enum member has a word a person would use", () => {
    for (const member of complaintCategoryEnum.enumValues) {
      assert.ok(
        COMPLAINT_CATEGORY_LABEL[member],
        `${member} has no label, so it would print raw on the drawer`,
      );
    }
  });

  test("offered labels round-trip through the stored value", () => {
    for (const label of COMPLAINT_CATEGORIES) {
      assert.equal(categoryLabel(categoryValue(label)), label);
    }
  });

  test("the labels this app used to offer still resolve", () => {
    // A complaint filed last year, a handset still on the old APK, and a
    // deployment whose list somebody curated all keep working.
    assert.equal(categoryValue("Packaging"), "packaging_damage");
    assert.equal(categoryValue("Packaging Damage"), "packaging_damage");
    assert.equal(categoryValue("Product Complaint"), "product_quality");
    assert.equal(categoryValue("Rate / Discount"), "pricing");
    assert.equal(categoryValue("Immediate Payment"), "billing_issue");
    assert.equal(categoryValue("Transportation"), "delivery");
    assert.equal(categoryValue("Staff"), "service");
    assert.equal(categoryValue("Sales Promotion"), "other");
  });

  test("it is not case or padding sensitive", () => {
    assert.equal(categoryValue("  billing issue "), "billing_issue");
    assert.equal(categoryValue("WRONG PRODUCT"), "wrong_product");
  });

  test("a category a manager adds is stored where its slug says, or as other", () => {
    // The Admin Console can add a heading without a deploy. Where the slug
    // happens to be a real member it is honoured; where it is not, the
    // complaint still saves rather than being refused at the door.
    assert.equal(categoryValue("Shortage"), "shortage");
    assert.equal(categoryValue("Something nobody has thought of"), "other");
  });

  test("an unmapped enum member prints itself rather than nothing", () => {
    assert.equal(categoryLabel("a_member_from_the_future"), "a_member_from_the_future");
  });
});

describe("complaint priority", () => {
  test("every offered priority is a real severity", () => {
    const members = new Set<string>(severityEnum.enumValues);
    for (const p of COMPLAINT_PRIORITIES) {
      assert.ok(members.has(p.value), `${p.value} is not a member of severity`);
    }
  });

  test("the default is Normal, and Normal is medium", () => {
    // `medium` is what complaints.defaultSeverity already shipped as, so every
    // complaint raised before this field existed reads as Normal rather than
    // as something nobody chose.
    assert.equal(DEFAULT_COMPLAINT_PRIORITY, "medium");
    assert.equal(priorityLabel("medium"), "Normal");
  });

  test("the three offered are Normal, Urgent and Critical, in that order", () => {
    assert.deepEqual(
      COMPLAINT_PRIORITIES.map((p) => p.label),
      ["Normal", "Urgent", "Critical"],
    );
  });

  test("every severity the column can hold has a label", () => {
    for (const member of severityEnum.enumValues) {
      assert.notEqual(priorityLabel(member), member, `${member} prints raw`);
    }
  });

  test("only Urgent and Critical read as demanding attention", () => {
    assert.equal(isEscalatedPriority("low"), false);
    assert.equal(isEscalatedPriority("medium"), false);
    assert.equal(isEscalatedPriority("high"), true);
    assert.equal(isEscalatedPriority("critical"), true);
  });

  test("low is kept resolvable and is no longer offered", () => {
    // Nothing in the business tells "less than normal" from normal, so it is
    // not a choice — but complaints carry it and a screen must not print
    // `low` at somebody.
    assert.equal(priorityLabel("low"), "Low");
    assert.ok(!COMPLAINT_PRIORITIES.some((p) => p.value === "low"));
  });
});
