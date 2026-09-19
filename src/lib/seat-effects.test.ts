import test from "node:test";
import assert from "node:assert/strict";
import { bookUnchangedNote } from "./seat-effects";

/* The one case that cost somebody a book: the paperwork seat moved, the book
 * left behind, and nothing on the screen saying so. */
test("moving only the back office seat says the book has not moved, and who holds it", () => {
  const note = bookUnchangedNote({
    changingSales: false,
    changingBackOffice: true,
    salesHolder: "Heena Pritesh Doshi",
  });
  assert.match(note ?? "", /not changing/);
  assert.match(note ?? "", /Heena Pritesh Doshi/);
});

test("an unheld sales seat says so rather than naming nobody", () => {
  const note = bookUnchangedNote({
    changingSales: false,
    changingBackOffice: true,
    salesHolder: null,
  });
  assert.match(note ?? "", /no salesperson/);
});

test("nothing is said where the book IS moving, or where neither seat is", () => {
  assert.equal(
    bookUnchangedNote({ changingSales: true, changingBackOffice: true, salesHolder: "A" }),
    null,
  );
  assert.equal(
    bookUnchangedNote({ changingSales: true, changingBackOffice: false, salesHolder: "A" }),
    null,
  );
  assert.equal(
    bookUnchangedNote({ changingSales: false, changingBackOffice: false, salesHolder: "A" }),
    null,
  );
});
