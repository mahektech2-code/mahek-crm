import test from "node:test";
import assert from "node:assert/strict";
import { amRoleEnum } from "@/db/schema";
import { SEAT_LABELS, seatLabel } from "@/lib/seat-labels";
import {
  HANDOVER_REFUSALS,
  handoverRefusal,
} from "@/lib/services/handover-service";

/* ---------------------------------------------------------------------------
 * §Q — the relationship handover, in the parts that need no database.
 * ------------------------------------------------------------------------- */

test("a lead cannot be handed over", () => {
  /* The seat means "who runs this account now that it is one". On a lead that
     job is `leadManagerId` — a different column, filled from the org chart —
     and allowing both would give a lead two coordinating seats with no rule
     saying which the notifications should name. */
  assert.equal(
    handoverRefusal({ kind: "lead", relationshipOwnerId: null }, "u1"),
    "not_a_customer",
  );
});

test("handing an account to whoever already runs it is refused, not repeated", () => {
  /* A no-op must write nothing: no seat, no history row, no notification.
     Telling somebody they have been handed eight accounts when three were
     already theirs is how a notification stops being read. */
  assert.equal(
    handoverRefusal({ kind: "customer", relationshipOwnerId: "u1" }, "u1"),
    "already_theirs",
  );
});

test("a converted account with nobody running it can be handed over", () => {
  assert.equal(
    handoverRefusal({ kind: "customer", relationshipOwnerId: null }, "u1"),
    null,
  );
});

test("an account already running under somebody else can be moved", () => {
  /* This is what makes an undo possible. There is deliberately no "hand back
     to nobody" control — taking a relationship back is handing it to whoever
     should hold it instead, which is the same act with a different name. */
  assert.equal(
    handoverRefusal({ kind: "customer", relationshipOwnerId: "u2" }, "u1"),
    null,
  );
});

test("every refusal has a sentence a person can act on", () => {
  for (const [code, sentence] of Object.entries(HANDOVER_REFUSALS)) {
    assert.ok(sentence.length > 20, `${code} needs a real explanation`);
    assert.ok(
      !sentence.includes("_"),
      `${code} is showing a stored code to a person: ${sentence}`,
    );
  }
});

/* ------------------------------------------------------------------ labels */

test("every seat the database can store has a label", () => {
  /*
   * THE POINT OF THIS TEST.
   *
   * The label was a ternary chain whose last arm was "Back office", so adding
   * a fourth seat relabelled it rather than failing — a handover rendering on
   * a customer's history as a back office change, silently, on the one screen
   * somebody reads to find out what happened to an account.
   *
   * Read off `amRoleEnum` rather than a list typed out here, so a fifth seat
   * fails this the moment it is added to the schema and not whenever somebody
   * next opens the record page.
   */
  for (const role of amRoleEnum.enumValues) {
    assert.ok(
      role in SEAT_LABELS,
      `am_role '${role}' has no label — the record page would name it as another seat`,
    );
  }
});

test("an unknown seat falls back to itself, never to another seat's name", () => {
  /* A stored value nothing can label is a bug worth seeing. Rendering it as
     "Back office" is the same bug, hidden. */
  assert.equal(seatLabel("something_new"), "something_new");
  assert.equal(seatLabel("relationship"), "Relationship");
});
