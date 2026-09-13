import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { remindersClosedBy, type ClosableReminder } from "./reminder-closure";

/* ===================================== what closes a promise, and what does not
 *
 * The point of every case here is the same one: a reminder must not be
 * closeable by anything weaker than evidence that the thing promised actually
 * happened. The manual button was the weakest possible evidence and is why
 * this engine exists — so the cases that matter most are the ones that DO NOT
 * close.
 */

const TODAY = "2026-09-13";

function rem(over: Partial<ClosableReminder> = {}): ClosableReminder {
  return { id: "rem_1", type: "call_back", dueDate: TODAY, ...over };
}

describe("a call", () => {
  test("closes a reminder due today", () => {
    const list = [rem()];
    assert.deepEqual(
      remindersClosedBy(list, { kind: "call", on: TODAY, answered: true }),
      ["rem_1"],
    );
  });

  test("closes one that is overdue", () => {
    const list = [rem({ dueDate: "2026-09-11" })];
    assert.deepEqual(
      remindersClosedBy(list, { kind: "call", on: TODAY, answered: true }),
      ["rem_1"],
    );
  });

  test("leaves a promise still ahead alone", () => {
    // The commitment for the 20th is not met by a conversation on the 13th,
    // and closing it here would destroy the only record that it is owed.
    const list = [rem({ dueDate: "2026-09-20" })];
    assert.deepEqual(
      remindersClosedBy(list, { kind: "call", on: TODAY, answered: true }),
      [],
    );
  });

  test("that nobody answered closes nothing", () => {
    // The whole reason `answered` is on the event. A list that can be cleared
    // by dialling and hanging up is the manual button wearing a disguise.
    const list = [rem({ dueDate: "2026-09-11" })];
    assert.deepEqual(
      remindersClosedBy(list, { kind: "call", on: TODAY, answered: false }),
      [],
    );
  });

  test("closes every kind of due reminder, not just a call back", () => {
    const list = [
      rem({ id: "a", type: "payment_promise" }),
      rem({ id: "b", type: "check_stock" }),
      rem({ id: "c", type: "send_information" }),
    ];
    assert.deepEqual(
      remindersClosedBy(list, { kind: "call", on: TODAY, answered: true }),
      ["a", "b", "c"],
    );
  });
});

describe("an order", () => {
  test("closes an order confirmation, however far ahead it was due", () => {
    const list = [rem({ type: "order_confirmation", dueDate: "2026-10-01" })];
    assert.deepEqual(remindersClosedBy(list, { kind: "order", on: TODAY }), [
      "rem_1",
    ]);
  });

  test("does not close a payment promise or a call back", () => {
    // An order is not the money, and it is not the conversation somebody
    // promised to have about something else.
    const list = [
      rem({ id: "a", type: "payment_promise" }),
      rem({ id: "b", type: "call_back" }),
    ];
    assert.deepEqual(remindersClosedBy(list, { kind: "order", on: TODAY }), []);
  });
});

describe("a confirmed payment", () => {
  test("closes a payment promise, however far ahead it was due", () => {
    const list = [rem({ type: "payment_promise", dueDate: "2026-10-01" })];
    assert.deepEqual(remindersClosedBy(list, { kind: "payment", on: TODAY }), [
      "rem_1",
    ]);
  });

  test("does not close anything else", () => {
    const list = [
      rem({ id: "a", type: "call_back" }),
      rem({ id: "b", type: "order_confirmation" }),
    ];
    assert.deepEqual(remindersClosedBy(list, { kind: "payment", on: TODAY }), []);
  });
});
