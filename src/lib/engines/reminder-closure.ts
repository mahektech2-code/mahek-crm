import type { BusinessDate } from "../business-date";

/* ---------------------------------------------------------------------------
 * WHAT CLOSES A PROMISE.
 *
 * A reminder is a promise somebody made to a customer, and until this existed
 * the only thing that could close one was a telecaller pressing "Mark done" —
 * which records that a button was pressed and nothing whatever about whether
 * the call was made. The overdue pile could be cleared in a minute by the one
 * person whose work it was measuring, and no screen anywhere could tell the
 * difference between a promise kept and a promise tidied away.
 *
 * So a promise is closed by the EVIDENCE that it was kept, not by an
 * assertion that it was. The evidence is a record that already exists for its
 * own reasons — a call in the interaction log, an order, a confirmed receipt —
 * and the reminder points back at the row, exactly as every other derived
 * statement in this product does.
 *
 * Pure, like every engine here: what happened goes in, the ids to close come
 * out. The three call sites are the transaction that writes a call, the one
 * that captures an order and the one that confirms money.
 * ------------------------------------------------------------------------- */

/** The reminder types this rule distinguishes. Mirrors `reminderTypeEnum`. */
export type ClosableReminderType =
  | "call_back"
  | "payment_promise"
  | "order_confirmation"
  | "send_information"
  | "check_stock"
  | "other";

export type ClosableReminder = {
  id: string;
  type: ClosableReminderType;
  dueDate: BusinessDate;
};

/**
 * Something that happened to a customer, on a business date.
 *
 * A CALL carries whether anybody answered. That distinction is the whole
 * reason the field is here: dialling a number that rings out is an attempt,
 * not a promise kept, and closing on it would hand back the same escape the
 * manual button gave — a list that can be cleared by dialling and hanging up.
 * An unanswered attempt leaves the reminder where it is, and the queue's own
 * no-answer ladder brings the customer back.
 */
export type ClosureEvent =
  | { kind: "call"; on: BusinessDate; answered: boolean }
  | { kind: "order"; on: BusinessDate }
  | { kind: "payment"; on: BusinessDate };

/**
 * Which of these pending reminders the event closes.
 *
 * A CALL closes a reminder that is DUE — today or overdue. Not one still
 * ahead: a customer rung on Tuesday about something else has not thereby had
 * the conversation promised for the 20th, and closing it would destroy a
 * commitment nobody has met. "Due" is the same line the screen's own Needs
 * action tab draws, so a telecaller who works that tab empties it by working
 * it.
 *
 * AN ORDER and a CONFIRMED PAYMENT close only the reminder that was about
 * exactly that, and they close it whatever its due date says. The thing
 * promised has happened — the money is in the bank, the order is on the
 * book — which is stronger evidence than any call could be, and a promise met
 * early is still met. A payment promised for the 20th that lands on the 15th
 * leaves nothing to ring about on the 20th.
 *
 * A REPORTED payment is deliberately not one of these. Money the customer says
 * has arrived is not money the business has seen — the rule the whole receipt
 * module turns on — and a promise closed on the customer's own word about
 * money is the manual button with extra steps. The call that reported it
 * closes the due reminder on its own merits; the payment closes it when
 * accounts find it.
 */
export function remindersClosedBy(
  pending: readonly ClosableReminder[],
  event: ClosureEvent,
): string[] {
  return pending.filter((r) => closes(r, event)).map((r) => r.id);
}

function closes(r: ClosableReminder, event: ClosureEvent): boolean {
  switch (event.kind) {
    case "call":
      return event.answered && r.dueDate <= event.on;
    case "order":
      return r.type === "order_confirmation";
    case "payment":
      return r.type === "payment_promise";
  }
}

/**
 * The sentence a closed reminder carries, in place of the note somebody would
 * have typed. It names the kind of evidence rather than the row's id, because
 * this is read on a screen; the id is stored beside it so the record can be
 * opened.
 */
export function closureNoteFor(event: ClosureEvent): string {
  switch (event.kind) {
    case "call":
      return "Closed by the call logged against this customer";
    case "order":
      return "Closed by the order taken from this customer";
    case "payment":
      return "Closed by the payment accounts confirmed";
  }
}
