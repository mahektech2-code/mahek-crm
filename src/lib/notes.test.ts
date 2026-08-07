import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { addLabel, dropLabel } from "./notes";

/* ---------------------------------------------------------------------------
 * A quick note is a shortcut for typing, so picking one and unpicking it has
 * to leave the telecaller exactly where they were — including whatever they
 * wrote themselves.
 * ------------------------------------------------------------------------- */

describe("quick notes write into the same box the telecaller types in", () => {
  test("picking appends, and the first one does not lead with a space", () => {
    assert.equal(addLabel("", "Repeat order"), "Repeat order");
    assert.equal(addLabel("Repeat order", "Urgent delivery"), "Repeat order Urgent delivery");
  });

  test("unpicking takes the words back out and closes the gap", () => {
    const two = addLabel(addLabel("", "Repeat order"), "Urgent delivery");
    assert.equal(dropLabel(two, "Repeat order"), "Urgent delivery");
    assert.equal(dropLabel(two, "Urgent delivery"), "Repeat order");
  });

  test("picking then unpicking is a round trip, whatever was already typed", () => {
    const typed = "Wants delivery before Diwali.";
    assert.equal(dropLabel(addLabel(typed, "Urgent delivery"), "Urgent delivery"), typed);
  });

  test("only the chip's own copy goes — what the telecaller typed is theirs", () => {
    // They wrote the same words in a sentence, then also tapped the chip.
    const text = addLabel("Customer says urgent delivery matters", "Urgent delivery");
    const after = dropLabel(text, "Urgent delivery");
    assert.equal(after, "Customer says urgent delivery matters");
  });

  test("unpicking something that is not there changes nothing", () => {
    assert.equal(dropLabel("Rate accepted", "Repeat order"), "Rate accepted");
  });

  test("a double tap cannot leave the same words twice", () => {
    // The bug this replaced: picking an already-picked chip appended again,
    // so the note read "Repeat order Repeat order" and meant one thing.
    const once = addLabel("", "Repeat order");
    assert.equal(dropLabel(once, "Repeat order"), "");
  });
});
