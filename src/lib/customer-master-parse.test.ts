import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CUSTOMER_MASTER_COL,
  flagSharedMobiles,
  looksLikeNote,
  parseCustomerMasterRow,
  readSheetStatus,
} from "./customer-master-parse";

/* ---------------------------------------------------------------------------
 * The shop master's reading rules, tested without a database.
 *
 * The two that earn their place here are the ones the real export actually
 * broke on: a mobile number that is syntactically perfect and sits on 952
 * unrelated shops, and an Address cell holding a sentence of Hindi about a
 * thinner sample. Neither is a parse failure — both cells read fine — which
 * is exactly why they have to be caught by a rule rather than by a person
 * noticing.
 * ------------------------------------------------------------------------- */

const C = CUSTOMER_MASTER_COL;

const row = (over: Record<string, string> = {}): Record<string, string> => ({
  [C.name]: "Burhani enterprises",
  [C.address]: "Agashi Rd, Sheetal Nagar, Virar West, Maharashtra, India",
  [C.mobile]: "9876543210",
  [C.location]: "Virar",
  [C.state]: "Maharashtra",
  [C.status]: "Active",
  ...over,
});

describe("parseCustomerMasterRow", () => {
  test("reads a complete row", () => {
    const r = parseCustomerMasterRow(row());
    assert.ok(r);
    assert.equal(r.customerName, "Burhani enterprises");
    assert.equal(r.nameKey, "BURHANI ENTERPRISES");
    assert.equal(r.mobile, "9876543210");
    assert.equal(r.locationText, "Virar");
    assert.deepEqual(r.issues, []);
  });

  test("a row with no name is not a shop, and is dropped", () => {
    assert.equal(parseCustomerMasterRow(row({ [C.name]: "   " })), null);
  });

  test("keeps the raw cell when the mobile cannot be read", () => {
    const r = parseCustomerMasterRow(row({ [C.mobile]: "phone at shop" }));
    assert.ok(r);
    assert.equal(r.mobile, null);
    assert.equal(r.mobileRaw, "phone at shop");
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].column, C.mobile);
  });

  test("takes the last ten digits of a number written with a country code", () => {
    const r = parseCustomerMasterRow(row({ [C.mobile]: "+91 98765 43210" }));
    assert.equal(r?.mobile, "9876543210");
  });

  test("a landline is not a mobile", () => {
    // Indian mobiles start 6-9; this one starts 2 and must not pass.
    const r = parseCustomerMasterRow(row({ [C.mobile]: "0224 2345678" }));
    assert.equal(r?.mobile, null);
  });

  test("a missing town is an issue, never a guess", () => {
    const r = parseCustomerMasterRow(row({ [C.location]: "" }));
    assert.ok(r);
    assert.equal(r.locationText, null);
    assert.ok(r.issues.some((i) => i.column === C.location));
  });

  test("a missing phone says the shop cannot be called", () => {
    const r = parseCustomerMasterRow(row({ [C.mobile]: "" }));
    assert.ok(r?.issues.some((i) => i.problem.includes("cannot be called")));
  });
});

describe("readSheetStatus", () => {
  test("folds the inconsistent casing the export actually holds", () => {
    // 2,090 `active` against 2,664 `Active` and 537 `Deactive`.
    assert.equal(readSheetStatus("active"), "active");
    assert.equal(readSheetStatus("Active"), "active");
    assert.equal(readSheetStatus("Deactive"), "deactive");
    assert.equal(readSheetStatus("deactive "), "deactive");
  });

  test("anything else is unknown rather than assumed active", () => {
    assert.equal(readSheetStatus("Hold"), null);
    assert.equal(readSheetStatus(null), null);
  });

  test("Deactive is not read as Active by prefix accident", () => {
    // "deactive".startsWith("active") is false, but the order of the two
    // checks is what guarantees it — pin the behaviour, not the reasoning.
    assert.notEqual(readSheetStatus("Deactive"), "active");
  });
});

describe("looksLikeNote", () => {
  test("a real address is not a note, however long", () => {
    assert.equal(
      looksLikeNote(
        "412, Hamidia Rd, near Ram mandir, Patel Nagar Colony, Ghora Nakkas, Peer Gate Area, Bhopal, Madhya Pradesh 462001, India",
      ),
      false,
    );
  });

  test("a sentence somebody typed into the address field is", () => {
    assert.equal(
      looksLikeNote(
        "Okay Prakash ji aap hai na sabse pahle thinner ka sample karvaiye Uske baad hi hum aage baat karenge aur abhi to hamare paas stock bhi bahut pada hua hai",
      ),
      true,
    );
  });

  test("a short cell is never a note", () => {
    assert.equal(looksLikeNote("Station Rd, Bhayandar"), false);
  });
});

describe("flagSharedMobiles", () => {
  test("finds the placeholder by repetition, not by a hard-coded number", () => {
    const rows = [
      { nameKey: "A", mobile: "9000000000" },
      { nameKey: "B", mobile: "9000000000" },
      { nameKey: "C", mobile: "9000000000" },
      { nameKey: "D", mobile: "9111111111" },
    ];
    const shared = flagSharedMobiles(rows);
    assert.equal(shared.get("9000000000"), 3);
    assert.equal(shared.has("9111111111"), false);
  });

  test("two shops sharing a number is ordinary and is left alone", () => {
    // A proprietor with two counters. The limit is where coincidence stops.
    const shared = flagSharedMobiles([
      { nameKey: "A", mobile: "9000000000" },
      { nameKey: "B", mobile: "9000000000" },
    ]);
    assert.equal(shared.size, 0);
  });

  test("rows with no mobile contribute nothing", () => {
    const shared = flagSharedMobiles([
      { nameKey: "A", mobile: null },
      { nameKey: "B", mobile: null },
      { nameKey: "C", mobile: null },
    ]);
    assert.equal(shared.size, 0);
  });
});
