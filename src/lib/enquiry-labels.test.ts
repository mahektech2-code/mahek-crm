/**
 * Website Enquiries — Senior Review Medium #13 (raw enum values in the UI).
 *
 * Pure and database-free, like every other `*-labels.ts` test in this
 * project: these maps are read by both a server component and a client
 * component, and neither should need a database to be exercised.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reminderTypeEnum, reminderStatusEnum, orderStatusEnum } from "@/db/schema";
import {
  ENQUIRY_STAGES,
  ENQUIRY_PRIORITIES,
  ENQUIRY_SOURCES,
  STAGE_LABEL,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  SOURCE_FORM_LABEL,
  REMINDER_TYPE_LABEL,
  ENQUIRY_REMINDER_TYPES,
  REMINDER_STATUS_LABEL,
  ENQUIRY_REMINDER_STATUSES,
  ORDER_STATUS_LABEL,
  ENQUIRY_ORDER_STATUSES,
  sourceLabel,
  sourceFormLabel,
  reminderTypeLabel,
  reminderStatusLabel,
  orderStatusLabel,
  CATEGORY_LABEL,
  categoryLabel,
} from "./enquiry-labels";
import { ENQUIRY_SOURCE_FORM_TYPES, ENQUIRY_SOURCE_CATEGORIES } from "./enquiry-ingest-validation";

/* -------------------------------------------------- internal values pinned */

describe("the internal values themselves are unchanged", () => {
  test("ENQUIRY_STAGES, ENQUIRY_PRIORITIES and ENQUIRY_SOURCES are the exact stored strings", () => {
    // These are what gets written to the database and put on the wire — a
    // label fix must never touch them. Pinned so a later edit to this file
    // that quietly renames one of them (rather than only its label) fails
    // here instead of on a filter that stops matching any row.
    assert.deepEqual(ENQUIRY_STAGES, ["new", "contacted", "follow_up", "qualified", "converted", "closed"]);
    assert.deepEqual(ENQUIRY_PRIORITIES, ["low", "normal", "high", "urgent"]);
    assert.deepEqual(ENQUIRY_SOURCES, ["website", "instagram", "facebook", "whatsapp", "indiamart", "google", "manual", "other"]);
  });

  test("REMINDER_TYPE_LABEL covers exactly the real reminder_type enum, value for value", () => {
    // Read off the schema rather than typed out here, the same discipline
    // `handover.test.ts` already uses for `amRoleEnum` — a value added to the
    // real enum without a label fails the build rather than silently showing
    // raw text to a manager.
    for (const value of reminderTypeEnum.enumValues) {
      assert.ok(value in REMINDER_TYPE_LABEL, `no label for reminder_type value "${value}"`);
    }
    assert.deepEqual(
      [...ENQUIRY_REMINDER_TYPES].sort(),
      [...reminderTypeEnum.enumValues].sort(),
      "ENQUIRY_REMINDER_TYPES must name exactly the database enum's own values",
    );
  });

  test("REMINDER_STATUS_LABEL covers exactly the real reminder_status enum, value for value (Senior #13)", () => {
    for (const value of reminderStatusEnum.enumValues) {
      assert.ok(value in REMINDER_STATUS_LABEL, `no label for reminder_status value "${value}"`);
    }
    assert.deepEqual(
      [...ENQUIRY_REMINDER_STATUSES].sort(),
      [...reminderStatusEnum.enumValues].sort(),
      "ENQUIRY_REMINDER_STATUSES must name exactly the database enum's own values",
    );
  });

  test("ORDER_STATUS_LABEL covers exactly the real order_status enum, value for value (Senior #13)", () => {
    for (const value of orderStatusEnum.enumValues) {
      assert.ok(value in ORDER_STATUS_LABEL, `no label for order_status value "${value}"`);
    }
    assert.deepEqual(
      [...ENQUIRY_ORDER_STATUSES].sort(),
      [...orderStatusEnum.enumValues].sort(),
      "ENQUIRY_ORDER_STATUSES must name exactly the database enum's own values",
    );
  });

  test("SOURCE_FORM_LABEL covers exactly the website's own form-type list", () => {
    for (const value of ENQUIRY_SOURCE_FORM_TYPES) {
      assert.ok(value in SOURCE_FORM_LABEL, `no label for source form "${value}"`);
    }
  });

  test("CATEGORY_LABEL covers exactly the website's own category list (Senior #18)", () => {
    for (const value of ENQUIRY_SOURCE_CATEGORIES) {
      assert.ok(value in CATEGORY_LABEL, `no label for category "${value}"`);
    }
  });
});

/* ----------------------------------------------------------- label output */

describe("the display helpers return the correct human-readable label", () => {
  test("sourceLabel", () => {
    assert.equal(sourceLabel("website"), "Website");
    assert.equal(sourceLabel("indiamart"), "IndiaMART");
    assert.equal(sourceLabel("whatsapp"), "WhatsApp");
  });

  test("sourceFormLabel", () => {
    assert.equal(sourceFormLabel("CONTACT"), "Contact");
    assert.equal(sourceFormLabel("QUICK_ENQUIRY"), "Quick Enquiry");
    assert.equal(sourceFormLabel("TECHNICAL_ENQUIRY"), "Technical Enquiry");
    assert.equal(sourceFormLabel(null), null, "no source form is no label, not a placeholder string");
    assert.equal(sourceFormLabel(undefined), null);
  });

  test("categoryLabel (Senior #18)", () => {
    assert.equal(categoryLabel("GENERAL"), "General");
    assert.equal(categoryLabel("SALES"), "Sales");
    assert.equal(categoryLabel("DISTRIBUTOR"), "Distributor");
    assert.equal(categoryLabel("CAREER"), "Career");
    assert.equal(categoryLabel("LOGISTICS"), "Logistics");
    assert.equal(categoryLabel(null), null, "no category is no label, not a placeholder string");
    assert.equal(categoryLabel(undefined), null);
  });

  test("reminderTypeLabel", () => {
    assert.equal(reminderTypeLabel("call_back"), "Call back");
    assert.equal(reminderTypeLabel("payment_promise"), "Payment promise");
    assert.equal(reminderTypeLabel("order_confirmation"), "Order confirmation");
  });

  test("reminderStatusLabel (Senior #13)", () => {
    assert.equal(reminderStatusLabel("pending"), "Pending");
    assert.equal(reminderStatusLabel("completed"), "Completed");
    assert.equal(reminderStatusLabel("dismissed"), "Dismissed");
  });

  test("orderStatusLabel (Senior #13)", () => {
    assert.equal(orderStatusLabel("pending_approval"), "Pending Approval");
    assert.equal(orderStatusLabel("captured"), "Captured");
    assert.equal(orderStatusLabel("declined"), "Declined");
    assert.equal(orderStatusLabel("confirmed"), "Confirmed");
    assert.equal(orderStatusLabel("dispatched"), "Dispatched");
    assert.equal(orderStatusLabel("in_transit"), "In Transit");
    assert.equal(orderStatusLabel("delivered"), "Delivered");
    assert.equal(orderStatusLabel("cancelled"), "Cancelled");
  });

  test("STAGE_LABEL and PRIORITY_LABEL still read as they did before this fix", () => {
    assert.equal(STAGE_LABEL.follow_up, "Follow-up");
    assert.equal(PRIORITY_LABEL.urgent, "Urgent");
    assert.equal(PRIORITY_LABEL.high, "High");
  });
});

/* --------------------------------------------------- unknown-value safety */

describe("an unrecognised value falls back safely rather than crashing", () => {
  test("sourceLabel of an unknown source shows the value itself", () => {
    assert.equal(sourceLabel("carrier_pigeon"), "carrier_pigeon");
  });

  test("sourceFormLabel of an unknown form shows the value itself", () => {
    assert.equal(sourceFormLabel("NINTH_FORM_THE_WEBSITE_ADDED"), "NINTH_FORM_THE_WEBSITE_ADDED");
  });

  test("reminderTypeLabel of an unknown type shows the value itself", () => {
    assert.equal(reminderTypeLabel("some_future_type"), "some_future_type");
  });

  test("reminderStatusLabel of an unknown status shows the value itself (Senior #13)", () => {
    assert.equal(reminderStatusLabel("some_future_status"), "some_future_status");
  });

  test("orderStatusLabel of an unknown status shows the value itself (Senior #13)", () => {
    assert.equal(orderStatusLabel("some_future_status"), "some_future_status");
  });

  test("categoryLabel of an unknown category shows the value itself (Senior #18)", () => {
    assert.equal(categoryLabel("NINTH_CATEGORY_THE_WEBSITE_ADDED"), "NINTH_CATEGORY_THE_WEBSITE_ADDED");
  });
});

/* ------------------------------------------- Senior finding #18 must not recur */

describe("category reaches the enquiry list and detail screens as a human label, never raw (Senior #18)", () => {
  test("the list screen renders category through categoryLabel, conditionally like sourceForm", () => {
    const src = readFileSync("src/components/enquiries/enquiry-list-screen.tsx", "utf8");
    assert.match(
      src,
      /\{e\.category \? <div className="text-xs text-muted">\{categoryLabel\(e\.category\)\}<\/div> : null\}/,
      "the list row must show the category label only when one is stored, exactly like the sourceForm line beside it",
    );
  });

  test("the detail screen renders category through categoryLabel as its own Field", () => {
    const src = readFileSync("src/components/enquiries/enquiry-detail-screen.tsx", "utf8");
    assert.match(
      src,
      /<Field label="Category"><div className="text-ink">\{categoryLabel\(enquiry\.category\) \?\? "—"\}<\/div><\/Field>/,
      "the enquiry info grid must show the category label, falling back to \"—\" exactly like Source form beside it",
    );
  });
});

/* ------------------------------------------- Senior finding #13 must not recur */

describe("no raw reminder/order status enum value reaches the enquiry detail screen (Senior #13)", () => {
  test("the reminder badge reads reminderStatusLabel(r.status), never the bare enum value", () => {
    const src = readFileSync("src/components/enquiries/enquiry-detail-screen.tsx", "utf8");
    assert.doesNotMatch(
      src,
      />\{r\.status\}<\//,
      "a reminder's raw status (\"pending\"/\"completed\"/\"dismissed\") must not be rendered as text",
    );
    assert.match(src, /\{reminderStatusLabel\(r\.status\)\}/, "the reminder status badge must read through reminderStatusLabel");
  });

  test("the linked-order badge reads orderStatusLabel(o.status), never the bare enum value", () => {
    const src = readFileSync("src/components/enquiries/enquiry-detail-screen.tsx", "utf8");
    assert.doesNotMatch(
      src,
      />\{o\.status\}<\//,
      "an order's raw status (e.g. \"pending_approval\") must not be rendered as text",
    );
    assert.match(src, /\{orderStatusLabel\(o\.status\)\}/, "the order status badge must read through orderStatusLabel");
  });
});

/* ------------------------------------------- the #5 bug must not recur */

describe("the source filter still submits the internal value, never the label (Senior #5)", () => {
  test("the filter's own <option> pairs value={s} (internal) with SOURCE_LABEL[s] (display)", () => {
    // A render test would need a DOM; reading the source is what
    // `mbos-wire.test.ts` and the timezone grep tests already do for an
    // invariant a type check cannot see — here, that the VALUE submitted by
    // the dropdown is never swapped for its own label, which is exactly how
    // Senior #5 broke the source filter the first time.
    const src = readFileSync("src/components/enquiries/enquiry-list-screen.tsx", "utf8");
    assert.match(
      src,
      /<option key=\{s\} value=\{s\}>\{SOURCE_LABEL\[s\]\}<\/option>/,
      "the source filter option must read value={s} (internal) and label {SOURCE_LABEL[s]} (display)",
    );
  });

  test("every value ENQUIRY_SOURCES offers has a label, so the filter never renders a blank option", () => {
    for (const s of ENQUIRY_SOURCES) assert.ok(SOURCE_LABEL[s]);
  });
});

/* -------------------------------------------------- Medium finding #14 */

describe("the reminder type has ONE canonical list, not one per file (Medium #14)", () => {
  test("enquiry-service.ts derives its type from enquiry-labels rather than repeating the six literals", () => {
    const src = readFileSync("src/lib/services/enquiry-service.ts", "utf8");
    assert.doesNotMatch(
      src,
      /"call_back"\s*\|\s*"payment_promise"/,
      "the six reminder-type literals must not be retyped here — import EnquiryReminderType instead",
    );
    assert.match(
      src,
      /EnquiryReminderType/,
      "createEnquiryReminder must be typed against the centralized EnquiryReminderType",
    );
  });

  test("enquiry-actions.ts derives its type from enquiry-labels rather than an inline union", () => {
    const src = readFileSync("src/lib/actions/enquiries.ts", "utf8");
    assert.doesNotMatch(
      src,
      /"call_back"\s*\|\s*"payment_promise"/,
      "the six reminder-type literals must not be retyped here — import EnquiryReminderType instead",
    );
    assert.match(src, /EnquiryReminderType/);
  });

  test("the detail screen's reminder dropdown is built from ENQUIRY_REMINDER_TYPES, not a hand-typed <option> list", () => {
    const src = readFileSync("src/components/enquiries/enquiry-detail-screen.tsx", "utf8");
    assert.match(
      src,
      /ENQUIRY_REMINDER_TYPES\.map/,
      "the create-reminder Type select must map over the centralized list",
    );
    assert.doesNotMatch(
      src,
      /<option value="call_back">Call back<\/option>/,
      "a second, hand-typed copy of the six options must not come back",
    );
  });

  test("the `type as never` cast around reminder creation is gone", () => {
    const src = readFileSync("src/components/enquiries/enquiry-detail-screen.tsx", "utf8");
    assert.doesNotMatch(src, /as never/, "reminder creation must be properly typed, not cast around");
  });
});

/* -------------------------------------------------------- Medium finding #19 */

describe("workspace and source are ONE constant each, not a literal at every call site (Medium #19)", () => {
  test("enquiry-service.ts defines ENQUIRY_WORKSPACE/ENQUIRY_SOURCE_WEBSITE and uses them everywhere, not a repeated bare literal", () => {
    const src = readFileSync("src/lib/services/enquiry-service.ts", "utf8");
    assert.match(src, /const ENQUIRY_WORKSPACE: AppId = "enquiries"/);
    assert.match(src, /const ENQUIRY_SOURCE_WEBSITE: EnquirySource = "website"/);

    // Every OTHER appearance of these two literal strings in the file must be
    // the constant definitions themselves — not a second, disconnected copy
    // typed out again at some other call site.
    const workspaceLiterals = src.match(/"enquiries"/g) ?? [];
    const websiteLiterals = src.match(/"website"/g) ?? [];
    assert.equal(workspaceLiterals.length, 1, "\"enquiries\" must appear exactly once — in the constant's own definition");
    assert.equal(websiteLiterals.length, 1, "\"website\" must appear exactly once — in the constant's own definition");
  });
});
