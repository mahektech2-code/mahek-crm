import test from "node:test";
import assert from "node:assert/strict";
import { newNoteText, survivesConversion } from "./converted-lead-note";

test("a note, a next action or a touch survives the lead becoming a customer", () => {
  assert.equal(survivesConversion({ id: "x", notes: "2026-11-20 — rang", lastActivityDate: "2026-11-20" }), true);
  assert.equal(
    survivesConversion({
      id: "x",
      nextAction: { action: "Call", date: "2026-11-28", ownerId: "u" },
      nextActionDate: "2026-11-28",
      nextActionOwnerId: "u",
      nextActionOutcome: null,
      nextFollowUpDate: "2026-11-28",
      lastActivityDate: "2026-11-26",
    }),
    true,
  );
});

test("anything else in the payload keeps the refusal — a rung means nothing on a customer", () => {
  assert.equal(survivesConversion({ id: "x", notes: "n", stage: "prospect" }), false);
  assert.equal(survivesConversion({ id: "x", archived: true }), false);
  assert.equal(survivesConversion({}), false);
  assert.equal(survivesConversion(null), false);
});

test("the new note is what follows what the office already holds", () => {
  const had = "2026-11-01 — first visit";
  assert.equal(newNoteText(had, `${had}\n2026-11-20 — wants the thinner price`), "2026-11-20 — wants the thinner price");
  assert.equal(newNoteText(had, had), null, "nothing new was said");
  assert.equal(newNoteText(null, "2026-11-20 — only note"), "2026-11-20 — only note");
  /* Out of line with the office's copy: the newest is the last line. */
  assert.equal(newNoteText("edited at a desk", "a\nb\nlatest"), "latest");
  assert.equal(newNoteText("x", "  "), null);
});
